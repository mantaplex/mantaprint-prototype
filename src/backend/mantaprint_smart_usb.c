/*
 * MantaPrint Smart CUPS USB Backend Wrapper
 * ========================================
 * High-reliability print backend wrapper for physical status tracking,
 * real-time IPP telemetry propagation, and prevention of premature
 * job completion on physical USB printers (Canon LBP6030 / UFR II LT).
 *
 * Architecture:
 * - argc == 1: Device discovery pass-through to /usr/lib/cups/backend/usb-cups-orig
 * - argc == 2 with --status: CLI hardware query with interface claiming
 * - argc >= 6: Full print job execution with pre-flight check, streaming,
 *              second-by-second mechanical progression, IPP telemetry
 *              (macOS/ChromeOS/Windows), and hardware/IPC attention handling.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <stdint.h>
#include <errno.h>
#include <dlfcn.h>
#include <ctype.h>

#define ORIG_BACKEND "/usr/lib/cups/backend/usb-cups-orig"
#define DEFAULT_VID  0x04a9
#define DEFAULT_PID  0x2795
#define IPC_ATTENTION_FILE "/run/mantaprint/printer_attention"
#define IPC_LEGACY_ATTENTION_FILE "/run/heykprint/printer_attention"

/* CUPS Backend Exit Codes (from <cups/backend.h>) */
#define CUPS_BACKEND_OK             0
#define CUPS_BACKEND_FAILED         1
#define CUPS_BACKEND_AUTH_REQUIRED  2
#define CUPS_BACKEND_HOLD           3
#define CUPS_BACKEND_STOP           4
#define CUPS_BACKEND_CANCEL         5
#define CUPS_BACKEND_RETRY          6
#define CUPS_BACKEND_RETRY_CURRENT  7

/* Dynamically loaded libusb-1.0 function pointers */
typedef int (*fn_libusb_init)(void **ctx);
typedef void (*fn_libusb_exit)(void *ctx);
typedef void *(*fn_libusb_open_device_with_vid_pid)(void *ctx, uint16_t vid, uint16_t pid);
typedef void (*fn_libusb_close)(void *dev_handle);
typedef int (*fn_libusb_control_transfer)(void *dev_handle, uint8_t req_type, uint8_t bReq,
                                         uint16_t wVal, uint16_t wIndex,
                                         unsigned char *data, uint16_t wLen, unsigned int timeout);
typedef int (*fn_libusb_claim_interface)(void *dev_handle, int interface_number);
typedef int (*fn_libusb_release_interface)(void *dev_handle, int interface_number);
typedef int (*fn_libusb_detach_kernel_driver)(void *dev_handle, int interface_number);
typedef int (*fn_libusb_attach_kernel_driver)(void *dev_handle, int interface_number);

static fn_libusb_init p_libusb_init = NULL;
static fn_libusb_exit p_libusb_exit = NULL;
static fn_libusb_open_device_with_vid_pid p_libusb_open = NULL;
static fn_libusb_close p_libusb_close = NULL;
static fn_libusb_control_transfer p_libusb_control = NULL;
static fn_libusb_claim_interface p_libusb_claim = NULL;
static fn_libusb_release_interface p_libusb_release = NULL;
static fn_libusb_detach_kernel_driver p_libusb_detach = NULL;
static fn_libusb_attach_kernel_driver p_libusb_attach = NULL;
static void *g_libusb_handle = NULL;

static int load_libusb(void) {
    if (g_libusb_handle) return 0;
    g_libusb_handle = dlopen("libusb-1.0.so.0", RTLD_NOW);
    if (!g_libusb_handle) {
        g_libusb_handle = dlopen("libusb-1.0.so", RTLD_NOW);
    }
    if (!g_libusb_handle) {
        return -1;
    }
    *(void **)(&p_libusb_init) = dlsym(g_libusb_handle, "libusb_init");
    *(void **)(&p_libusb_exit) = dlsym(g_libusb_handle, "libusb_exit");
    *(void **)(&p_libusb_open) = dlsym(g_libusb_handle, "libusb_open_device_with_vid_pid");
    *(void **)(&p_libusb_close) = dlsym(g_libusb_handle, "libusb_close");
    *(void **)(&p_libusb_control) = dlsym(g_libusb_handle, "libusb_control_transfer");
    *(void **)(&p_libusb_claim) = dlsym(g_libusb_handle, "libusb_claim_interface");
    *(void **)(&p_libusb_release) = dlsym(g_libusb_handle, "libusb_release_interface");
    *(void **)(&p_libusb_detach) = dlsym(g_libusb_handle, "libusb_detach_kernel_driver");
    *(void **)(&p_libusb_attach) = dlsym(g_libusb_handle, "libusb_attach_kernel_driver");

    if (!p_libusb_init || !p_libusb_exit || !p_libusb_open || !p_libusb_close || !p_libusb_control) {
        dlclose(g_libusb_handle);
        g_libusb_handle = NULL;
        return -2;
    }
    return 0;
}

static volatile sig_atomic_t g_stop = 0;
static volatile pid_t g_child_pid = 0;

static void sig_handler(int signo) {
    (void)signo;
    g_stop = 1;
    if (g_child_pid > 0) {
        kill(g_child_pid, SIGTERM);
    }
}

/* Sleep for specified milliseconds while checking g_stop */
static void msleep(int ms) {
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (ms % 1000) * 1000000L;
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR) {
        if (g_stop) break;
    }
}

/* Query USB Printer Class GET_PORT_STATUS (Request 1, bmRequestType 0xA1) */
static int query_port_status(uint16_t vid, uint16_t pid, unsigned char *status_byte) {
    if (!p_libusb_open || !p_libusb_control || !p_libusb_close) return -1;
    void *h = p_libusb_open(NULL, vid, pid);
    if (!h) {
        return -1; /* Device disconnected or inaccessible */
    }
    int ret = p_libusb_control(h, 0xA1, 1, 0, 0, status_byte, 1, 1000);
    p_libusb_close(h);
    return (ret == 1) ? 0 : -2;
}

/* Helper to detect page count from options, spool file, or headers */
static int detect_job_pages(int argc, char *argv[]) {
    int pages = 1;

    /* 1. Check options in argv[5] for page-ranges=X-Y */
    if (argc >= 6 && argv[5]) {
        const char *pr = strstr(argv[5], "page-ranges=");
        if (pr) {
            pr += 12;
            int start_p = 1, end_p = 1;
            if (sscanf(pr, "%d-%d", &start_p, &end_p) == 2 && end_p >= start_p) {
                pages = end_p - start_p + 1;
                return pages;
            } else if (sscanf(pr, "%d", &start_p) == 1 && start_p > 0) {
                return 1;
            }
        }
    }

    /* 2. Check input file in argv[6] if present */
    if (argc >= 7 && argv[6] && argv[6][0] != '\0') {
        FILE *fp = fopen(argv[6], "rb");
        if (fp) {
            char buf[4096];
            size_t n = fread(buf, 1, sizeof(buf) - 1, fp);
            buf[n] = '\0';
            
            /* Check PostScript %%Pages: N */
            char *pg = strstr(buf, "%%Pages:");
            if (pg) {
                int p = 0;
                if (sscanf(pg + 8, "%d", &p) == 1 && p > 0) {
                    pages = p;
                    fclose(fp);
                    return pages;
                }
            }
            
            /* Check PDF /Count N in pages dict */
            char *cnt = strstr(buf, "/Count ");
            if (cnt) {
                int p = 0;
                if (sscanf(cnt + 7, "%d", &p) == 1 && p > 0) {
                    pages = p;
                    fclose(fp);
                    return pages;
                }
            }
            fclose(fp);
        }
    }

    /* 3. Check CUPS spool control file /var/spool/cups/c%05d */
    if (argc >= 2 && argv[1]) {
        int jid = atoi(argv[1]);
        if (jid > 0) {
            char cpath[128];
            snprintf(cpath, sizeof(cpath), "/var/spool/cups/c%05d", jid);
            FILE *fp = fopen(cpath, "rb");
            if (fp) {
                char sbuf[4096];
                size_t n = fread(sbuf, 1, sizeof(sbuf) - 1, fp);
                sbuf[n] = '\0';
                char *pos = strstr(sbuf, "job-impressions-completed");
                if (pos) {
                    /* If available, use impression count */
                }
                fclose(fp);
            }
        }
    }

    return (pages > 0) ? pages : 1;
}

/* Helper to check IPC attention trigger file (/run/heykprint/printer_attention) */
static int check_ipc_attention(char *msg_buf, size_t max_len) {
    struct stat st;
    if (stat(IPC_ATTENTION_FILE, &st) != 0) {
        return 0; /* No active IPC attention */
    }
    FILE *fp = fopen(IPC_ATTENTION_FILE, "r");
    if (!fp) return 0;
    if (fgets(msg_buf, (int)max_len, fp)) {
        size_t l = strlen(msg_buf);
        while (l > 0 && (msg_buf[l-1] == '\n' || msg_buf[l-1] == '\r')) {
            msg_buf[--l] = '\0';
        }
    } else {
        snprintf(msg_buf, max_len, "Perhatian: Printer membutuhkan tindakan fisik.");
    }
    fclose(fp);
    return 1;
}

static void cleanup_canon_daemon(void) {
    int ret = system("killall -9 cnrsdrvsfp 2>/dev/null");
    (void)ret;
}

static const char *get_orig_backend(const char *self_path) {
    if (access(ORIG_BACKEND, X_OK) == 0) {
        return ORIG_BACKEND;
    }
    if (access("/usr/lib/cups/backend/usb", X_OK) == 0 && self_path && strcmp(self_path, "/usr/lib/cups/backend/usb") != 0) {
        return "/usr/lib/cups/backend/usb";
    }
    return ORIG_BACKEND;
}

int main(int argc, char *argv[]) {
    const char *orig_backend = get_orig_backend(argv[0]);

    /* 1. Device Discovery Mode (argc == 1) */
    if (argc == 1) {
        execv(orig_backend, argv);
        fprintf(stderr, "ERROR: Unable to execute original backend %s: %s\n", orig_backend, strerror(errno));
        return CUPS_BACKEND_FAILED;
    }

    uint16_t target_vid = DEFAULT_VID;
    uint16_t target_pid = DEFAULT_PID;

    const char *env_vid = getenv("MANTAPRINT_USB_VID"); if (!env_vid) env_vid = getenv("HEYKPRINT_USB_VID");
    const char *env_pid = getenv("MANTAPRINT_USB_PID"); if (!env_pid) env_pid = getenv("HEYKPRINT_USB_PID");
    if (env_vid) target_vid = (uint16_t)strtol(env_vid, NULL, 0);
    if (env_pid) target_pid = (uint16_t)strtol(env_pid, NULL, 0);

    /* CLI Diagnostics / Status Mode (argc == 2 with --status / -s) */
    if (argc == 2 && (strcmp(argv[1], "--status") == 0 || strcmp(argv[1], "-s") == 0)) {
        if (load_libusb() != 0 || p_libusb_init(NULL) != 0) {
            printf("ERROR: Failed to initialize libusb\n");
            return 1;
        }
        unsigned char st = 0;
        int q = query_port_status(target_vid, target_pid, &st);
        if (q != 0) {
            printf("STATUS: OFFLINE (Device not found or communication failed)\n");
            printf("IPP_REASON: connecting-to-device\n");
            printf("MESSAGE: Printer tidak terhubung atau mati via USB.\n");
        } else {
            int pe = (st & 0x20) != 0;
            int sel = (st & 0x10) != 0;
            int nerr = (st & 0x08) != 0;
            printf("STATUS: 0x%02x (PaperEmpty=%d, Selected=%d, NotError=%d)\n", st, pe, sel, nerr);
            if (pe) {
                printf("IPP_REASON: media-empty-warning\n");
                printf("MESSAGE: Kertas printer habis! Harap isi kertas pada baki (tray).\n");
            } else if (!nerr) {
                if (!sel) {
                    printf("IPP_REASON: door-open-error\n");
                    printf("MESSAGE: Pintu penutup printer terbuka!\n");
                } else {
                    printf("IPP_REASON: media-jam-error\n");
                    printf("MESSAGE: Kertas tersangkut (Paper Jam)!\n");
                }
            } else {
                printf("IPP_REASON: none\n");
                printf("MESSAGE: Printer siap (Ready / Idle).\n");
            }
        }
        p_libusb_exit(NULL);
        dlclose(g_libusb_handle);
        return 0;
    }

    /* 2. Validate Print Job Arguments */
    if (argc < 6) {
        fprintf(stderr, "ERROR: Usage: %s job-id user title copies options [file]\n", argv[0]);
        return CUPS_BACKEND_FAILED;
    }

    /* Setup signal handlers for graceful cancellation from CUPS */
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = sig_handler;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);

    int job_id = atoi(argv[1]);
    const char *job_user = argv[2];
    const char *job_title = argv[3];
    int copies = atoi(argv[4]);
    if (copies < 1) copies = 1;

    int doc_pages = detect_job_pages(argc, argv);
    int total_sheets = doc_pages * copies;

    fprintf(stderr, "DEBUG: mantaprint-smart-usb: job=%d user='%s' title='%s' pages=%d copies=%d total_sheets=%d\n",
            job_id, job_user, job_title, doc_pages, copies, total_sheets);

    /* Clear any lingering state flags from previous abnormal terminations */
    fprintf(stderr, "STATE: -door-open\n");
    fprintf(stderr, "STATE: -door-open-error\n");
    fprintf(stderr, "STATE: -media-jam\n");
    fprintf(stderr, "STATE: -media-jam-error\n");
    fprintf(stderr, "STATE: -media-needed\n");
    fprintf(stderr, "STATE: -media-empty-warning\n");
    fprintf(stderr, "STATE: -connecting-to-device\n");
    fflush(stderr);

    /* Check DEVICE_URI: If this queue belongs to a non-Canon printer (e.g. Epson, HP, Brother, POS thermal)
     * and no custom VID/PID was specified via env vars, delegate immediately to standard backend */
    const char *dev_uri = getenv("DEVICE_URI");
    int has_custom_vid_pid = (env_vid != NULL || env_pid != NULL);
    if (!has_custom_vid_pid && dev_uri != NULL) {
        char uri_buf[256];
        snprintf(uri_buf, sizeof(uri_buf), "%s", dev_uri);
        for (int i = 0; uri_buf[i]; i++) uri_buf[i] = tolower(uri_buf[i]);
        if (!strstr(uri_buf, "canon") && !strstr(uri_buf, "lbp") && !strstr(uri_buf, "04a9")) {
            fprintf(stderr, "DEBUG: mantaprint-smart-usb: Non-Canon target queue (%s), delegating directly to %s\n", dev_uri, orig_backend);
            execv(orig_backend, argv);
            fprintf(stderr, "ERROR: Unable to execute original backend %s: %s\n", orig_backend, strerror(errno));
            return CUPS_BACKEND_FAILED;
        }
    }

    /* Dynamically load libusb-1.0 runtime */
    int has_libusb = (load_libusb() == 0 && p_libusb_init(NULL) == 0);
    int is_smart_device = 0;

    if (!has_libusb) {
        fprintf(stderr, "DEBUG: mantaprint-smart-usb: libusb loading unavailable, delegating directly to %s\n", orig_backend);
    } else {
        /* 3. Phase 1: Pre-flight Hardware Status Check */
        int preflight_warned = 0;
        int preflight_retries = 0;
        while (!g_stop) {
            unsigned char st = 0;
            int qret = query_port_status(target_vid, target_pid, &st);
            if (qret == -1) {
                preflight_retries++;
                /* If device is not found after 2 attempts, proceed as generic USB device */
                if (preflight_retries >= 2) {
                    fprintf(stderr, "DEBUG: mantaprint-smart-usb: Device %04x:%04x not found or generic USB printer, delegating to %s\n",
                            target_vid, target_pid, orig_backend);
                    is_smart_device = 0;
                    break;
                }
                if (!preflight_warned) {
                    fprintf(stderr, "STATE: +connecting-to-device\n");
                    fprintf(stderr, "ATTR: job-state-reasons=connecting-to-device\n");
                    fprintf(stderr, "ATTR: job-printer-state-message=Menghubungkan ke printer fisik via USB...\n");
                    fprintf(stderr, "INFO: Menunggu koneksi printer fisik via USB...\n");
                    fflush(stderr);
                    preflight_warned = 1;
                }
                msleep(1000);
                continue;
            } else if (qret != 0) {
                preflight_retries++;
                /* If printer engine queries repeatedly fail/stall, fallback to standard backend */
                if (preflight_retries >= 3) {
                    fprintf(stderr, "DEBUG: mantaprint-smart-usb: Device %04x:%04x query failed (code %d), delegating to %s\n",
                            target_vid, target_pid, qret, orig_backend);
                    is_smart_device = 0;
                    break;
                }
                /* Printer engine stalled or timed out (Amber blinking / paper needed) */
                if (!preflight_warned || preflight_warned != 2) {
                    fprintf(stderr, "STATE: +media-needed\n");
                    fprintf(stderr, "STATE: +media-empty-warning\n");
                    fprintf(stderr, "ATTR: job-state-reasons=media-needed,job-suspended\n");
                    fprintf(stderr, "ATTR: job-printer-state-message=Kertas habis! Masukkan kertas ke baki dan tekan tombol Resume printer.\n");
                    fprintf(stderr, "INFO: Kertas printer habis! Masukkan kertas ke baki dan tekan Resume...\n");
                    fflush(stderr);
                    preflight_warned = 2;
                }
                msleep(1000);
                continue;
            }

            /* Hardware responded successfully */
            is_smart_device = 1;
            int paper_empty = (st & 0x20) != 0;
            int not_error = (st & 0x08) != 0;

            if (paper_empty) {
                fprintf(stderr, "STATE: +media-needed\n");
                fprintf(stderr, "STATE: +media-empty-warning\n");
                fprintf(stderr, "ATTR: job-state-reasons=media-needed,job-suspended\n");
                fprintf(stderr, "ATTR: job-printer-state-message=Kertas habis! Masukkan kertas ke baki dan tekan tombol Resume printer.\n");
                fprintf(stderr, "INFO: Kertas printer habis. Harap muat kertas ke baki masukan...\n");
                fflush(stderr);
                preflight_warned = 3;
                msleep(1000);
                continue;
            }

            if (!not_error) {
                fprintf(stderr, "STATE: +door-open\n");
                fprintf(stderr, "STATE: +door-open-error\n");
                fprintf(stderr, "ATTR: job-state-reasons=door-open,job-suspended\n");
                fprintf(stderr, "ATTR: job-printer-state-message=Penutup printer terbuka atau terjadi masalah mekanik!\n");
                fprintf(stderr, "INFO: Penutup printer terbuka / hardware error...\n");
                fflush(stderr);
                preflight_warned = 4;
                msleep(1000);
                continue;
            }

            /* Check IPC attention pre-flight */
            char ipc_msg[256];
            if (check_ipc_attention(ipc_msg, sizeof(ipc_msg))) {
                fprintf(stderr, "STATE: +media-needed\n");
                fprintf(stderr, "ATTR: job-state-reasons=media-needed,job-suspended\n");
                fprintf(stderr, "ATTR: job-printer-state-message=%s\n", ipc_msg);
                fprintf(stderr, "INFO: %s\n", ipc_msg);
                fflush(stderr);
                preflight_warned = 1;
                msleep(1000);
                continue;
            }

            /* Hardware is ready! Clear any pre-flight warnings */
            if (preflight_warned) {
                fprintf(stderr, "STATE: -connecting-to-device\n");
                fprintf(stderr, "STATE: -media-needed\n");
                fprintf(stderr, "STATE: -media-empty-warning\n");
                fprintf(stderr, "STATE: -door-open\n");
                fprintf(stderr, "STATE: -door-open-error\n");
                fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
                fprintf(stderr, "ATTR: job-printer-state-message=Printer siap. Memulai pengiriman data cetak...\n");
                fprintf(stderr, "INFO: Printer siap. Memulai transmisi raster...\n");
                fflush(stderr);
            }
            break;
        }
    }

    if (g_stop) {
        if (has_libusb) p_libusb_exit(NULL);
        if (g_libusb_handle) dlclose(g_libusb_handle);
        return CUPS_BACKEND_CANCEL;
    }

    /* 4. Phase 2: Stream Data to Printer via Original CUPS USB Backend */
    fprintf(stderr, "PAGE: 1 1\n");
    fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
    fprintf(stderr, "ATTR: job-printer-state-message=Mengirim raster data ke memori printer...\n");
    fprintf(stderr, "INFO: Mengirim data raster dokumen ke memori printer...\n");
    fflush(stderr);

    pid_t child = fork();
    if (child == 0) {
        /* Child process executes original backend */
        execv(orig_backend, argv);
        fprintf(stderr, "ERROR: mantaprint-smart-usb: Failed to execute %s: %s\n", orig_backend, strerror(errno));
        _exit(CUPS_BACKEND_FAILED);
    } else if (child < 0) {
        fprintf(stderr, "ERROR: mantaprint-smart-usb: fork failed: %s\n", strerror(errno));
        if (has_libusb) p_libusb_exit(NULL);
        if (g_libusb_handle) dlclose(g_libusb_handle);
        return CUPS_BACKEND_FAILED;
    }

    g_child_pid = child;
    int child_status = 0;
    while (waitpid(child, &child_status, 0) < 0) {
        if (errno == EINTR) {
            if (g_stop) {
                kill(child, SIGTERM);
            }
            continue;
        }
        break;
    }
    g_child_pid = 0;

    int child_exit = WIFEXITED(child_status) ? WEXITSTATUS(child_status) : CUPS_BACKEND_FAILED;

    /* Handle graceful cancellation: do NOT report CUPS_BACKEND_FAILED to avoid cupsdisable */
    if (g_stop) {
        if (has_libusb) p_libusb_exit(NULL);
        if (g_libusb_handle) dlclose(g_libusb_handle);
        return CUPS_BACKEND_CANCEL;
    }
    if (WIFSIGNALED(child_status)) {
        int sig = WTERMSIG(child_status);
        if (sig == SIGTERM || sig == SIGINT) {
            if (has_libusb) p_libusb_exit(NULL);
            if (g_libusb_handle) dlclose(g_libusb_handle);
            return CUPS_BACKEND_CANCEL;
        }
    }

    if (child_exit != CUPS_BACKEND_OK) {
        fprintf(stderr, "ERROR: mantaprint-smart-usb: %s exited with error code %d\n", orig_backend, child_exit);
        if (has_libusb) p_libusb_exit(NULL);
        if (g_libusb_handle) dlclose(g_libusb_handle);
        cleanup_canon_daemon();
        if (child_exit == CUPS_BACKEND_FAILED && g_stop) {
            return CUPS_BACKEND_CANCEL;
        }
        return child_exit;
    }

    /* If not a smart tracked device (e.g. Epson, HP, thermal), complete immediately */
    if (!is_smart_device) {
        if (has_libusb) p_libusb_exit(NULL);
        if (g_libusb_handle) dlclose(g_libusb_handle);
        return CUPS_BACKEND_OK;
    }

    /*
     * 5. Phase 3: Post-Transfer Mechanical Print & Real-Time IPP Progression Loop
     *
     * Physical Reality of Canon LBP6030 Engine:
     * - Cold fuser warmup & engine spin-up: ~6.0s
     * - Laser scan + pickup roller + transit + fusing: ~3.5s per sheet
     * - Total mechanical duration: T_mech = 6.0 + (total_sheets * 3.5s)
     *
     * Endpoint Telemetry (macOS, ChromeOS, iOS, Windows):
     * - Stream page-by-page progress: PAGE: X Y, job-printer-state-message
     * - If attention is required (paper out / amber halt / jam), emit standard
     *   IPP reasons (media-needed, media-jam, door-open) and hold job active!
     */
    double fuser_warmup = 2.0;
    double sec_per_sheet = 1.5;
    double total_mech_sec = fuser_warmup + (total_sheets * sec_per_sheet);

    fprintf(stderr, "DEBUG: mantaprint-smart-usb: Raster transfer done. Mechanical cycle: %.1fs (sheets=%d)\n",
            total_mech_sec, total_sheets);
    fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
    fprintf(stderr, "ATTR: job-printer-state-message=Sedang mencetak dokumen fisik (lembar 1/%d)...\n", total_sheets);
    fprintf(stderr, "INFO: Printer sedang menarik kertas dan memproses cetakan fisik...\n");
    fflush(stderr);

    time_t mech_start = time(NULL);
    int empty_warned = 0;
    int jam_warned = 0;
    int door_warned = 0;
    int conn_warned = 0;
    int ipc_warned = 0;
    int steady_ok_count = 0;
    int last_reported_sheet = 0;
    int disconnect_count = 0;

    while (!g_stop) {
        msleep(500); /* 2 Hz loop */
        time_t now = time(NULL);
        double elapsed = difftime(now, mech_start);

        /* 5A. Check Hardware Port Status via LibUSB */
        unsigned char st = 0;
        int qret = query_port_status(target_vid, target_pid, &st);
        if (qret == -1) {
            disconnect_count++;
            if (disconnect_count > 6) {
                fprintf(stderr, "DEBUG: mantaprint-smart-usb: Device %04x:%04x disconnected or finished mechanical cycle\n", target_vid, target_pid);
                break;
            }
            /* Disconnected during print cycle */
            if (!conn_warned) {
                fprintf(stderr, "STATE: +connecting-to-device\n");
                fprintf(stderr, "ATTR: job-state-reasons=connecting-to-device\n");
                fprintf(stderr, "ATTR: job-printer-state-message=Printer terputus saat siklus cetak fisik!\n");
                fflush(stderr);
                conn_warned = 1;
            }
            steady_ok_count = 0;
            continue;
        } else if (qret != 0) {
            /* Printer engine stalled / timed out (Amber blinking / paper needed) */
            if (!empty_warned) {
                fprintf(stderr, "STATE: +media-needed\n");
                fprintf(stderr, "STATE: +media-empty-warning\n");
                fprintf(stderr, "ATTR: job-state-reasons=media-needed,job-suspended\n");
                fprintf(stderr, "ATTR: job-printer-state-message=Kertas habis! Masukkan kertas ke baki dan tekan tombol Resume printer.\n");
                fprintf(stderr, "INFO: Kertas printer habis saat proses mencetak! Menunggu kertas diisi...\n");
                fflush(stderr);
                empty_warned = 1;
            }
            steady_ok_count = 0;
            continue;
        } else {
            /* qret == 0 */
            disconnect_count = 0;
            if (conn_warned) {
                fprintf(stderr, "STATE: -connecting-to-device\n");
                fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
                fprintf(stderr, "ATTR: job-printer-state-message=Printer terhubung kembali.\n");
                fflush(stderr);
                conn_warned = 0;
            }

            int paper_empty = (st & 0x20) != 0;
            int not_error = (st & 0x08) != 0;
            int selected = (st & 0x10) != 0;

            if (paper_empty) {
                if (!empty_warned) {
                    fprintf(stderr, "STATE: +media-needed\n");
                    fprintf(stderr, "STATE: +media-empty-warning\n");
                    fprintf(stderr, "ATTR: job-state-reasons=media-needed,job-suspended\n");
                    fprintf(stderr, "ATTR: job-printer-state-message=Kertas habis! Masukkan kertas ke baki dan tekan tombol Resume printer.\n");
                    fprintf(stderr, "INFO: Kertas habis saat proses mencetak. Menunggu kertas diisi...\n");
                    fflush(stderr);
                    empty_warned = 1;
                }
                steady_ok_count = 0;
                continue;
            } else if (empty_warned) {
                fprintf(stderr, "STATE: -media-needed\n");
                fprintf(stderr, "STATE: -media-empty-warning\n");
                fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
                fprintf(stderr, "ATTR: job-printer-state-message=Kertas diisi kembali. Melanjutkan pencetakan fisik...\n");
                fprintf(stderr, "INFO: Kertas terdeteksi kembali. Melanjutkan cetak fisik...\n");
                fflush(stderr);
                empty_warned = 0;
                mech_start = time(NULL);
                elapsed = 0;
            }

            if (!not_error) {
                if (!selected) {
                    if (!door_warned) {
                        fprintf(stderr, "STATE: +door-open\n");
                        fprintf(stderr, "STATE: +door-open-error\n");
                        fprintf(stderr, "ATTR: job-state-reasons=door-open,job-suspended\n");
                        fprintf(stderr, "ATTR: job-printer-state-message=Pintu penutup printer terbuka!\n");
                        fprintf(stderr, "INFO: Pintu printer terbuka saat mencetak!\n");
                        fflush(stderr);
                        door_warned = 1;
                    }
                } else {
                    if (!jam_warned) {
                        fprintf(stderr, "STATE: +media-jam\n");
                        fprintf(stderr, "STATE: +media-jam-error\n");
                        fprintf(stderr, "ATTR: job-state-reasons=media-jam,job-suspended\n");
                        fprintf(stderr, "ATTR: job-printer-state-message=Kertas tersangkut (Paper Jam)! Harap bersihkan baki/jalur kertas.\n");
                        fprintf(stderr, "INFO: Terjadi paper jam fisik di dalam printer!\n");
                        fflush(stderr);
                        jam_warned = 1;
                    }
                }
                steady_ok_count = 0;
                continue;
            } else {
                if (door_warned) {
                    fprintf(stderr, "STATE: -door-open\n");
                    fprintf(stderr, "STATE: -door-open-error\n");
                    fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
                    fprintf(stderr, "ATTR: job-printer-state-message=Penutup printer ditutup kembali.\n");
                    fflush(stderr);
                    door_warned = 0;
                    mech_start = time(NULL);
                    elapsed = 0;
                }
                if (jam_warned) {
                    fprintf(stderr, "STATE: -media-jam\n");
                    fprintf(stderr, "STATE: -media-jam-error\n");
                    fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
                    fprintf(stderr, "ATTR: job-printer-state-message=Paper jam teratasi. Melanjutkan siklus fisik...\n");
                    fflush(stderr);
                    jam_warned = 0;
                    mech_start = time(NULL);
                    elapsed = 0;
                }
            }
        }

        /* 5B. Check IPC Attention Trigger */
        char ipc_msg[256];
        if (check_ipc_attention(ipc_msg, sizeof(ipc_msg))) {
            if (!ipc_warned) {
                fprintf(stderr, "STATE: +media-needed\n");
                fprintf(stderr, "ATTR: job-state-reasons=media-needed,job-suspended\n");
                fprintf(stderr, "ATTR: job-printer-state-message=%s\n", ipc_msg);
                fprintf(stderr, "INFO: %s\n", ipc_msg);
                fflush(stderr);
                ipc_warned = 1;
            }
            steady_ok_count = 0;
            continue;
        } else if (ipc_warned) {
            fprintf(stderr, "STATE: -media-needed\n");
            fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
            fprintf(stderr, "ATTR: job-printer-state-message=Tindakan fisik selesai. Melanjutkan pencetakan...\n");
            fprintf(stderr, "INFO: Perhatian fisik selesai diproses.\n");
            fflush(stderr);
            ipc_warned = 0;
            mech_start = time(NULL);
            elapsed = 0;
        }

        /* 5C. Stream Progression to Endpoints (macOS / ChromeOS / Windows) */
        int cur_sheet = 1;
        if (elapsed > fuser_warmup) {
            cur_sheet = (int)((elapsed - fuser_warmup) / sec_per_sheet) + 1;
            if (cur_sheet > total_sheets) cur_sheet = total_sheets;
        }

        if (cur_sheet != last_reported_sheet) {
            fprintf(stderr, "PAGE: %d %d\n", cur_sheet, copies);
            fprintf(stderr, "ATTR: job-state-reasons=job-printing\n");
            fprintf(stderr, "ATTR: job-printer-state-message=Sedang mencetak dokumen fisik (lembar %d/%d)...\n",
                    cur_sheet, total_sheets);
            fprintf(stderr, "INFO: Sedang mencetak dokumen fisik (lembar %d/%d)...\n",
                    cur_sheet, total_sheets);
            fflush(stderr);
            last_reported_sheet = cur_sheet;
        }

        /* 5D. Check Mechanical Completion */
        if (elapsed >= total_mech_sec && qret == 0 && (st & 0x08) != 0 && (st & 0x20) == 0 && !empty_warned) {
            steady_ok_count++;
            if (steady_ok_count >= 2) { /* 1.0s of clean idle verification */
                fprintf(stderr, "DEBUG: mantaprint-smart-usb: Physical mechanical cycle confirmed complete (%.1fs elapsed).\n", elapsed);
                break;
            }
        }
    }

    /* 6. Release Job to Completed */
    fprintf(stderr, "STATE: -media-needed\n");
    fprintf(stderr, "STATE: -media-empty-warning\n");
    fprintf(stderr, "STATE: -media-jam\n");
    fprintf(stderr, "STATE: -media-jam-error\n");
    fprintf(stderr, "STATE: -door-open\n");
    fprintf(stderr, "STATE: -door-open-error\n");
    fprintf(stderr, "ATTR: job-state-reasons=job-completed-successfully\n");
    fprintf(stderr, "ATTR: job-printer-state-message=Dokumen fisik selesai dicetak ke baki output.\n");
    fprintf(stderr, "INFO: Dokumen berhasil dicetak ke baki output printer.\n");
    fflush(stderr);

    p_libusb_exit(NULL);
    dlclose(g_libusb_handle);
    cleanup_canon_daemon();
    return g_stop ? CUPS_BACKEND_CANCEL : CUPS_BACKEND_OK;
}
