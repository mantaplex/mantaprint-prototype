import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Printer, Server, Activity, ShieldCheck, HardDrive, RefreshCw, 
  Search, Filter, Send, Download, AlertTriangle, CheckCircle2, 
  Clock, Cpu, Database, ChevronRight, ChevronLeft, ChevronsLeft, 
  ChevronsRight, Terminal, Plus, Eye, Layers, Settings, Laptop, 
  ArrowUpRight, Zap, Wifi, WifiOff, Trash2, X, Check, Copy, 
  AlertCircle, Info, Folder, Tag, ArrowUpDown, SlidersHorizontal, 
  FileText, CheckSquare, Square, MinusSquare, BarChart3
} from 'lucide-react';

// --- ENTERPRISE ERROR BOUNDARY ---
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[HeykPrint UI ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-4">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-extrabold text-white">Terjadi Kesalahan pada Dashboard</h2>
          <p className="text-xs text-slate-400 mt-2 max-w-md">
            Komponen UI mengalami kendala tak terduga. Sistem fail-safe HeykPrint Enterprise mencegah kerusakan data.
          </p>
          <div className="mt-3 p-3 bg-slate-900 border border-slate-800 rounded-lg text-[11px] font-mono text-rose-300 max-w-lg overflow-auto">
            {this.state.error?.message || 'Unknown render error'}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/20 transition flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" /> Muat Ulang Dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- MAIN ENTERPRISE APPLICATION ---
export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <ConsoleDashboard />
    </ErrorBoundary>
  );
}

function ConsoleDashboard() {
  // Navigation & Core Data
  const [activeTab, setActiveTab] = useState('fleet'); // 'fleet' | 'drivers' | 'pending' | 'network'
  const [devices, setDevices] = useState([]);
  const [stats, setStats] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Real-Time Native WebSocket State
  const [wsStatus, setWsStatus] = useState('connecting'); // 'connected' | 'connecting' | 'reconnecting' | 'disconnected'
  const [wsRetryCount, setWsRetryCount] = useState(0);
  const [lastPing, setLastPing] = useState(null);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  // Advanced Filtering & Search
  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('All');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [filterErrorOnly, setFilterErrorOnly] = useState(false);
  const [filterLiveOnly, setFilterLiveOnly] = useState(false);

  // Sorting & Pagination (Enterprise 600 units scale)
  const [sortField, setSortField] = useState('status'); // 'status' | 'id' | 'ip' | 'cpu_temp' | 'jobs_completed' | 'last_seen'
  const [sortAsc, setSortAsc] = useState(true);
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);

  // Multi-Select Batch Operations
  const [selectedIds, setSelectedIds] = useState([]);
  const [batchActionLoading, setBatchActionLoading] = useState(null);

  // Modals & Drawers
  const [detailDrawerDevice, setDetailDrawerDevice] = useState(null);
  const [detailTab, setDetailTab] = useState('telemetry'); // 'telemetry' | 'queue' | 'logs' | 'config'
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [logFilter, setLogFilter] = useState('');
  const [logAutoScroll, setLogAutoScroll] = useState(true);
  const logContainerRef = useRef(null);

  const [assignGroupModal, setAssignGroupModal] = useState(false);
  const [targetGroupName, setTargetGroupName] = useState('Jakarta');
  const [customGroupInput, setCustomGroupInput] = useState('');

  const [deployModal, setDeployModal] = useState(null);
  const [deployTarget, setDeployTarget] = useState('All');
  const [deployProgress, setDeployProgress] = useState(null);
  const [adoptModal, setAdoptModal] = useState(null);

  const [actionLoading, setActionLoading] = useState({});

  // Toast Notifications Stack
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((msg, type = 'success', title = '') => {
    const id = Date.now() + Math.random().toString(36).substring(2, 6);
    setToasts(prev => [...prev.slice(-4), { id, msg, type, title }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // --- HTTP Data Fetching ---
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [statsRes, fleetRes, driversRes] = await Promise.all([
        fetch('/api/stats').then(r => r.ok ? r.json() : null),
        fetch('/api/fleet').then(r => r.ok ? r.json() : []),
        fetch('/api/drivers').then(r => r.ok ? r.json() : [])
      ]);
      if (statsRes) setStats(statsRes);
      if (fleetRes) setDevices(fleetRes);
      if (driversRes) setDrivers(driversRes);
    } catch (err) {
      console.error('Data fetch failed:', err);
      if (!silent) addToast('Gagal memuat data dari server', 'error', 'Koneksi API');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [addToast]);

  // --- Realtime Native WebSocket Stream ---
  const connectWebSocket = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?type=ui`;

    setWsStatus(prev => prev === 'connected' ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      setWsRetryCount(0);
      setLastPing(Date.now());
      fetchData(true);
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { type, data } = payload;

        if (type === 'connected') {
          setLastPing(Date.now());
        } else if (type === 'heartbeat') {
          setLastPing(Date.now());
        } else if (type === 'fleet_updated') {
          fetchData(true);
        } else if (type === 'telemetry_update') {
          setLastPing(Date.now());
          if (data && data.id) {
            setDevices(prev => prev.map(dev => {
              if (dev.id !== data.id) return dev;
              return {
                ...dev,
                cpu_temp: data.system?.cpu_temp ?? dev.cpu_temp,
                ram_used_mb: data.system?.ram_used_mb ?? dev.ram_used_mb,
                printer_state: data.printer?.state ?? dev.printer_state,
                toner_cmyk: data.toner ?? dev.toner_cmyk,
                jobs_completed: data.jobs_completed ?? dev.jobs_completed,
                storage_info: data.system?.storage ? JSON.stringify(data.system.storage) : dev.storage_info,
                last_seen: Date.now()
              };
            }));

            // If detail drawer is viewing this device, update live
            setDetailDrawerDevice(prev => {
              if (!prev || prev.id !== data.id) return prev;
              return {
                ...prev,
                cpu_temp: data.system?.cpu_temp ?? prev.cpu_temp,
                ram_used_mb: data.system?.ram_used_mb ?? prev.ram_used_mb,
                printer_state: data.printer?.state ?? prev.printer_state,
                toner_cmyk: data.toner ?? prev.toner_cmyk,
                jobs_completed: data.jobs_completed ?? prev.jobs_completed,
                storage_info: data.system?.storage ? JSON.stringify(data.system.storage) : prev.storage_info,
                last_seen: Date.now()
              };
            });
          }
        } else if (type === 'device_connected') {
          addToast(`Unit ${data.id || 'STB'} terhubung live!`, 'info', 'Perangkat Online');
          fetchData(true);
        } else if (type === 'device_disconnected') {
          fetchData(true);
        } else if (type === 'command_result') {
          if (data?.message) {
            addToast(data.message, data.success ? 'success' : 'error', 'Hasil Perintah');
          }
          fetchData(true);
        }
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };

    ws.onclose = () => {
      setWsStatus('reconnecting');
      wsRef.current = null;
      setWsRetryCount(prev => {
        const next = prev + 1;
        const delay = Math.min(1000 * Math.pow(1.5, next), 8000);
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, delay);
        return next;
      });
    };

    ws.onerror = (err) => {
      console.warn('WS stream error:', err);
      ws.close();
    };
  }, [fetchData, addToast]);

  useEffect(() => {
    fetchData();
    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWebSocket, fetchData]);

  // Periodic Keepalive / Ping
  useEffect(() => {
    const pingInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
    return () => clearInterval(pingInterval);
  }, []);

  // --- Fetch Detail Data when Drawer Opens ---
  const loadDeviceDetail = useCallback(async (dev) => {
    setDetailDrawerDevice(dev);
    setDetailLoading(true);
    setDetailTab('telemetry');
    try {
      const res = await fetch(`/api/fleet/detail?id=${encodeURIComponent(dev.id)}`);
      if (res.ok) {
        const data = await res.json();
        setDetailData(data);
      } else {
        addToast('Gagal memuat telemetry detail', 'error', dev.id);
      }
    } catch (err) {
      console.error('Detail fetch error:', err);
    } finally {
      setDetailLoading(false);
    }
  }, [addToast]);

  // Auto-scroll logs when tab is active
  useEffect(() => {
    if (detailTab === 'logs' && logAutoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [detailTab, detailData?.logs, logAutoScroll]);

  // --- Batch & Multi-Select Operations ---
  const handleToggleSelect = (id) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const handleSelectAllFiltered = (filteredList) => {
    const filteredIds = filteredList.map(d => d.id);
    const allSelected = filteredIds.every(id => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds(prev => prev.filter(id => !filteredIds.includes(id)));
    } else {
      setSelectedIds(prev => Array.from(new Set([...prev, ...filteredIds])));
    }
  };

  const handleBulkAction = async (action, actionTitle) => {
    if (selectedIds.length === 0) return;
    setBatchActionLoading(action);
    try {
      const res = await fetch('/api/fleet/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_ids: selectedIds,
          action
        })
      });
      const data = await res.json();
      if (res.ok) {
        addToast(
          `${actionTitle} sukses dikirim ke ${selectedIds.length} unit (${data.broadcast_count || 0} unit live)!`,
          'success',
          'Operasi Massal'
        );
        fetchData(true);
      } else {
        addToast(data.error || 'Operasi massal gagal', 'error', 'Operasi Massal');
      }
    } catch (err) {
      addToast('Koneksi server gagal', 'error', 'Operasi Massal');
    } finally {
      setBatchActionLoading(null);
    }
  };

  const handleBulkClearJobs = async () => {
    if (selectedIds.length === 0) return;
    setBatchActionLoading('clear_jobs');
    try {
      const res = await fetch('/api/fleet/jobs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_ids: selectedIds })
      });
      const data = await res.json();
      if (res.ok) {
        addToast(`Antrean print dibersihkan untuk ${data.cleared_count} unit!`, 'success', 'Batal Antrean Massal');
        fetchData(true);
      } else {
        addToast(data.error || 'Gagal membersihkan antrean', 'error');
      }
    } catch (err) {
      addToast('Koneksi terputus', 'error');
    } finally {
      setBatchActionLoading(null);
    }
  };

  const handleApplyAssignGroup = async () => {
    const finalGroup = customGroupInput.trim() || targetGroupName;
    if (!finalGroup) return;

    setBatchActionLoading('assign_group');
    try {
      const res = await fetch('/api/fleet/assign-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_ids: selectedIds,
          group_tag: finalGroup
        })
      });
      const data = await res.json();
      if (res.ok) {
        addToast(`${selectedIds.length} unit berhasil dipindahkan ke grup '${finalGroup}'!`, 'success', 'Assign Grup');
        setAssignGroupModal(false);
        setCustomGroupInput('');
        fetchData(true);
      } else {
        addToast(data.error || 'Gagal mengubah grup', 'error');
      }
    } catch (err) {
      addToast('Gagal menghubungi server', 'error');
    } finally {
      setBatchActionLoading(null);
    }
  };

  // --- Single Device Actions ---
  const handleDeviceAction = async (id, action, label = 'Perintah') => {
    setActionLoading(prev => ({ ...prev, [id]: action }));
    try {
      const res = await fetch('/api/fleet/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action })
      });
      const data = await res.json();
      if (res.ok) {
        addToast(`Perintah '${action}' berhasil dikirim ke ${id}!`, 'success', label);
        if (detailDrawerDevice?.id === id) {
          loadDeviceDetail(detailDrawerDevice);
        }
      } else {
        addToast(data.error || 'Gagal mengirim perintah', 'error', label);
      }
    } catch (err) {
      addToast('Koneksi ke server gagal', 'error', label);
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: null }));
      fetchData(true);
    }
  };

  const handleClearSingleDeviceJobs = async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: 'clear_jobs' }));
    try {
      const res = await fetch('/api/fleet/jobs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        addToast(`Antrean print unit ${id} berhasil dikosongkan!`, 'success', 'Clear Spooler');
        if (detailDrawerDevice?.id === id) {
          loadDeviceDetail(detailDrawerDevice);
        }
        fetchData(true);
      } else {
        addToast('Gagal membersihkan antrean', 'error');
      }
    } catch (err) {
      addToast('Koneksi gagal', 'error');
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: null }));
    }
  };

  // --- Adopt Device ---
  const handleAdoptDevice = async (e) => {
    e.preventDefault();
    if (!adoptModal) return;
    const form = e.target;
    const label = form.label.value;
    const group_tag = form.group_tag.value;

    try {
      const res = await fetch('/api/fleet/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: adoptModal.id, label, group_tag })
      });
      if (res.ok) {
        addToast(`Perangkat ${adoptModal.id} berhasil diadopsi dan aktif!`, 'success', 'Otorisasi Unit');
        setAdoptModal(null);
        fetchData(true);
      } else {
        addToast('Gagal mengadopsi perangkat', 'error');
      }
    } catch (err) {
      addToast('Gagal menghubungi server', 'error');
    }
  };

  // --- Deploy Driver ---
  const handleDeployDriver = async () => {
    if (!deployModal) return;
    setDeployProgress('Mendistribusikan paket driver CUPS...');
    try {
      const payload = {
        driver_id: deployModal.id,
        target_group: deployTarget === 'Selected' ? null : deployTarget,
        device_ids: deployTarget === 'Selected' ? selectedIds : null
      };

      const res = await fetch('/api/drivers/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        addToast(
          `Driver ${deployModal.name} berhasil di-push ke ${data.active_pushed} unit online!`,
          'success',
          'Deploy Driver Selesai'
        );
        setDeployModal(null);
        setDeployProgress(null);
        fetchData(true);
      } else {
        addToast(data.error || 'Deploy gagal', 'error', 'Deploy Driver');
        setDeployProgress(null);
      }
    } catch (err) {
      addToast('Koneksi server gagal', 'error', 'Deploy Driver');
      setDeployProgress(null);
    }
  };

  // --- Advanced Filtering & Sorting Logic ---
  const availableGroups = useMemo(() => {
    const set = new Set();
    devices.forEach(d => { if (d.group_tag) set.add(d.group_tag); });
    if (set.size === 0) set.add('General');
    return ['All', ...Array.from(set)];
  }, [devices]);

  const groupCounts = useMemo(() => {
    const counts = { All: devices.length };
    devices.forEach(d => {
      counts[d.group_tag] = (counts[d.group_tag] || 0) + 1;
    });
    return counts;
  }, [devices]);

  const filteredDevices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return devices.filter(dev => {
      // Search matching: Hostname, IP, MAC, Label, Printer Name, ID
      if (q) {
        const matchesHostname = dev.hostname?.toLowerCase().includes(q);
        const matchesIp = dev.ip?.toLowerCase().includes(q);
        const matchesMac = dev.mac?.toLowerCase().includes(q);
        const matchesLabel = dev.label?.toLowerCase().includes(q);
        const matchesPrinter = dev.printer_name?.toLowerCase().includes(q);
        const matchesId = dev.id?.toLowerCase().includes(q);
        if (!matchesHostname && !matchesIp && !matchesMac && !matchesLabel && !matchesPrinter && !matchesId) {
          return false;
        }
      }

      // Group filter
      if (selectedGroup !== 'All' && dev.group_tag !== selectedGroup) {
        return false;
      }

      // Status filter
      if (selectedStatus !== 'All' && dev.status !== selectedStatus) {
        return false;
      }

      // Error filter
      if (filterErrorOnly) {
        const isError = ['stopped', 'error', 'disconnected'].includes(dev.printer_state) || dev.status === 'offline';
        if (!isError) return false;
      }

      // Live WS filter
      if (filterLiveOnly && !dev.is_connected_live) {
        return false;
      }

      return true;
    });
  }, [devices, search, selectedGroup, selectedStatus, filterErrorOnly, filterLiveOnly]);

  const sortedDevices = useMemo(() => {
    return [...filteredDevices].sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];

      // Custom priority for status
      if (sortField === 'status') {
        const rank = { pending: 1, online: 2, offline: 3 };
        valA = rank[a.status] || 4;
        valB = rank[b.status] || 4;
      }

      if (valA < valB) return sortAsc ? -1 : 1;
      if (valA > valB) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [filteredDevices, sortField, sortAsc]);

  // Paginated devices
  const totalPages = Math.ceil(sortedDevices.length / (pageSize === 'All' ? sortedDevices.length || 1 : pageSize));
  const paginatedDevices = useMemo(() => {
    if (pageSize === 'All') return sortedDevices;
    const start = (currentPage - 1) * pageSize;
    return sortedDevices.slice(start, start + pageSize);
  }, [sortedDevices, currentPage, pageSize]);

  // Pagination helper buttons
  const isAllFilteredSelected = useMemo(() => {
    if (filteredDevices.length === 0) return false;
    return filteredDevices.every(d => selectedIds.includes(d.id));
  }, [filteredDevices, selectedIds]);

  const isSomeFilteredSelected = useMemo(() => {
    return selectedIds.length > 0 && !isAllFilteredSelected;
  }, [selectedIds, isAllFilteredSelected]);

  const pendingDevices = useMemo(() => devices.filter(d => d.status === 'pending'), [devices]);
  const errorDevicesCount = useMemo(() => {
    return devices.filter(d => ['stopped', 'error', 'disconnected'].includes(d.printer_state) || d.status === 'offline').length;
  }, [devices]);

  const resetAllFilters = () => {
    setSearch('');
    setSelectedGroup('All');
    setSelectedStatus('All');
    setFilterErrorOnly(false);
    setFilterLiveOnly(false);
    setCurrentPage(1);
  };

  const hasActiveFilters = search || selectedGroup !== 'All' || selectedStatus !== 'All' || filterErrorOnly || filterLiveOnly;

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col font-['Plus_Jakarta_Sans',sans-serif]">
      {/* Toast Notification Container */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto px-4 py-3 rounded-xl shadow-2xl border text-xs flex items-start gap-2.5 transition-all transform animate-in slide-in-from-top-2 duration-200 ${
              t.type === 'success' ? 'bg-emerald-950/95 border-emerald-700/80 text-emerald-200' :
              t.type === 'error' ? 'bg-rose-950/95 border-rose-700/80 text-rose-200' :
              t.type === 'warning' ? 'bg-amber-950/95 border-amber-700/80 text-amber-200' :
              'bg-indigo-950/95 border-indigo-700/80 text-indigo-200'
            }`}
          >
            {t.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />}
            {t.type === 'error' && <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />}
            {t.type === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />}
            {t.type === 'info' && <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />}
            <div className="flex-1">
              {t.title && <div className="font-bold text-[11px] uppercase tracking-wider mb-0.5 opacity-90">{t.title}</div>}
              <div className="font-medium leading-relaxed">{t.msg}</div>
            </div>
            <button
              onClick={() => removeToast(t.id)}
              className="text-slate-400 hover:text-white p-0.5 transition"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Top Navbar */}
      <header className="border-b border-slate-800/80 bg-[#0d1322]/90 backdrop-blur sticky top-0 z-40 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-700 flex items-center justify-center shadow-lg shadow-indigo-500/25 border border-indigo-400/20">
            <Printer className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-base tracking-tight text-white">HeykPrint</span>
              <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shadow-inner">
                Enterprise v2.2
              </span>
            </div>
            <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <span>Fleet Orchestration & Spooler Control</span>
              <span className="text-slate-600">•</span>
              <span className="text-indigo-400 font-mono">Target: 600 STB Appliances</span>
            </p>
          </div>
        </div>

        {/* Global Live Stats & WebSocket Status Indicator */}
        <div className="hidden lg:flex items-center gap-4 text-xs">
          {/* WebSocket Status Indicator */}
          {wsStatus === 'connected' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="font-semibold">Live WS Stream</span>
              <span className="text-[10px] text-emerald-400/70 font-mono">
                {lastPing ? `${Math.max(0, Math.round((Date.now() - lastPing) / 1000))}s lalu` : 'Aktif'}
              </span>
            </div>
          )}

          {wsStatus === 'reconnecting' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-950/40 border border-amber-800/60 text-amber-300 font-medium animate-pulse">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>WS Reconnecting (coba ke-{wsRetryCount})...</span>
            </div>
          )}

          {wsStatus === 'disconnected' && (
            <button
              onClick={connectWebSocket}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-950/50 border border-rose-800/60 text-rose-300 font-medium hover:bg-rose-900/50 transition"
            >
              <WifiOff className="w-3.5 h-3.5 text-rose-400" />
              <span>WS Offline • Klik Hubungkan</span>
            </button>
          )}

          {/* Fleets count */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-slate-400">Armada Online:</span>
            <span className="font-bold text-emerald-400">
              {stats?.fleet?.online || 0} / {devices.length}
            </span>
          </div>

          {/* Errors count */}
          {errorDevicesCount > 0 && (
            <div 
              onClick={() => setFilterErrorOnly(prev => !prev)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-950/40 border border-rose-800/60 text-rose-300 cursor-pointer hover:bg-rose-900/40 transition"
              title="Klik untuk filter hanya unit error"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
              <span>Printer Bermasalah:</span>
              <span className="font-bold text-rose-400">{errorDevicesCount}</span>
            </div>
          )}

          {/* Total Jobs */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-slate-400">Total Print:</span>
            <span className="font-bold text-indigo-300">
              {(stats?.total_jobs_printed || devices.reduce((sum, d) => sum + (d.jobs_completed || 0), 0)).toLocaleString()} Hal
            </span>
          </div>
        </div>

        {/* Right Header Actions */}
        <div className="flex items-center gap-2.5">
          <button 
            onClick={() => fetchData()} 
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition"
            title="Refresh Manual"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Main Navigation Tabs */}
      <nav className="border-b border-slate-800 bg-[#090d16] px-6">
        <div className="flex items-center gap-1 overflow-x-auto">
          {[
            { id: 'fleet', label: `Fleet Matrix (${devices.length} Unit)`, icon: Layers },
            { id: 'drivers', label: 'Driver Registry & Deploy', icon: HardDrive, count: drivers.length },
            { id: 'pending', label: 'Pending Adoption', icon: Clock, badge: pendingDevices.length },
            { id: 'network', label: 'Zero-Touch & Option 43', icon: ShieldCheck }
          ].map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition relative whitespace-nowrap ${
                  isActive 
                    ? 'border-indigo-500 text-indigo-400 bg-indigo-500/5 font-bold' 
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
                {tab.badge > 0 && (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Body Content */}
      <main className="flex-1 p-6 max-w-[1500px] w-full mx-auto space-y-6">
        
        {/* ============================================================ */}
        {/* TAB 1: FLEET MATRIX */}
        {/* ============================================================ */}
        {activeTab === 'fleet' && (
          <div className="space-y-4">
            
            {/* Advanced Search & Filter Bar */}
            <div className="bg-[#0f172a]/90 p-4 rounded-2xl border border-slate-800/90 shadow-xl space-y-3">
              <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
                {/* Search Bar */}
                <div className="flex-1 relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Pencarian cepat: Hostname, IP, MAC (b8:27:eb:..), Model Printer, atau Label..."
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="w-full pl-10 pr-9 py-2 text-xs bg-slate-900 border border-slate-700/80 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                  />
                  {search && (
                    <button
                      onClick={() => setSearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Status and Quick Toggles */}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Status Dropdown */}
                  <select
                    value={selectedStatus}
                    onChange={(e) => {
                      setSelectedStatus(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="px-3 py-2 text-xs bg-slate-900 border border-slate-700/80 rounded-xl text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="All">Semua Status Unit</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                    <option value="pending">Pending</option>
                  </select>

                  {/* Filter Only Error */}
                  <button
                    onClick={() => {
                      setFilterErrorOnly(prev => !prev);
                      setCurrentPage(1);
                    }}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition ${
                      filterErrorOnly
                        ? 'bg-rose-950 border-rose-600 text-rose-300 ring-1 ring-rose-500'
                        : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <AlertTriangle className={`w-3.5 h-3.5 ${filterErrorOnly ? 'text-rose-400' : 'text-slate-400'}`} />
                    <span>Printer Bermasalah ({errorDevicesCount})</span>
                  </button>

                  {/* Filter Live WS */}
                  <button
                    onClick={() => {
                      setFilterLiveOnly(prev => !prev);
                      setCurrentPage(1);
                    }}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition ${
                      filterLiveOnly
                        ? 'bg-emerald-950 border-emerald-600 text-emerald-300 ring-1 ring-emerald-500'
                        : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Zap className={`w-3.5 h-3.5 ${filterLiveOnly ? 'text-emerald-400' : 'text-slate-400'}`} />
                    <span>Live WS Only</span>
                  </button>

                  {/* Reset Filters */}
                  {hasActiveFilters && (
                    <button
                      onClick={resetAllFilters}
                      className="px-2.5 py-2 text-xs rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                      title="Reset Semua Filter"
                    >
                      Reset Filter
                    </button>
                  )}
                </div>
              </div>

              {/* Group Chips Bar */}
              <div className="flex items-center gap-1.5 overflow-x-auto pt-1 pb-0.5 scrollbar-thin">
                <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1 mr-1 shrink-0">
                  <Folder className="w-3.5 h-3.5 text-indigo-400" /> Grup:
                </span>
                {availableGroups.map(g => {
                  const isSel = selectedGroup === g;
                  const count = groupCounts[g] || 0;
                  return (
                    <button
                      key={g}
                      onClick={() => {
                        setSelectedGroup(g);
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1 text-xs rounded-lg transition whitespace-nowrap flex items-center gap-1.5 ${
                        isSel 
                          ? 'bg-indigo-600 text-white font-bold shadow-md shadow-indigo-600/30' 
                          : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                      }`}
                    >
                      <span>{g}</span>
                      <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                        isSel ? 'bg-indigo-800 text-indigo-200' : 'bg-slate-800 text-slate-400'
                      }`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* STICKY BATCH & MULTI-SELECT ACTION BAR */}
            {selectedIds.length > 0 && (
              <div className="sticky top-16 z-30 bg-gradient-to-r from-indigo-950/95 via-[#111827]/95 to-slate-900/95 backdrop-blur border border-indigo-500/50 p-3.5 rounded-2xl shadow-2xl flex flex-wrap items-center justify-between gap-3 animate-in slide-in-from-top-3 duration-200">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-300 font-bold text-xs">
                    {selectedIds.length}
                  </div>
                  <div>
                    <span className="font-bold text-white text-xs">
                      {selectedIds.length} unit terpilih
                    </span>
                    <span className="text-[11px] text-slate-400 ml-1.5">
                      dari {filteredDevices.length} unit filter
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {/* Bulk Test Print */}
                  <button
                    onClick={() => handleBulkAction('test_print', 'Bulk Test Print')}
                    disabled={!!batchActionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/25 transition disabled:opacity-50"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>Bulk Test Print</span>
                  </button>

                  {/* Bulk Restart Spooler */}
                  <button
                    onClick={() => handleBulkAction('restart_cups', 'Restart Spooler Massal')}
                    disabled={!!batchActionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${batchActionLoading === 'restart_cups' ? 'animate-spin' : ''}`} />
                    <span>Bulk Restart Spooler</span>
                  </button>

                  {/* Bulk Deploy Driver */}
                  <button
                    onClick={() => {
                      if (drivers.length > 0) {
                        setDeployModal(drivers[0]);
                        setDeployTarget('Selected');
                      } else {
                        addToast('Belum ada driver terdaftar di registry', 'warning');
                      }
                    }}
                    disabled={!!batchActionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md shadow-emerald-600/25 transition disabled:opacity-50"
                  >
                    <HardDrive className="w-3.5 h-3.5" />
                    <span>Bulk Deploy Driver</span>
                  </button>

                  {/* Assign Group */}
                  <button
                    onClick={() => setAssignGroupModal(true)}
                    disabled={!!batchActionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold shadow-md shadow-violet-600/25 transition disabled:opacity-50"
                  >
                    <Tag className="w-3.5 h-3.5" />
                    <span>Assign Group</span>
                  </button>

                  {/* Clear Stuck Jobs */}
                  <button
                    onClick={handleBulkClearJobs}
                    disabled={!!batchActionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-900/60 hover:bg-rose-800/80 text-rose-200 text-xs font-semibold border border-rose-700/60 transition disabled:opacity-50"
                    title="Batalkan antrean stuck di semua unit terpilih"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear Stuck Jobs</span>
                  </button>

                  {/* Deselect All */}
                  <button
                    onClick={() => setSelectedIds([])}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
                    title="Batalkan Pilihan"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Fleet Matrix Table */}
            <div className="bg-[#0f172a]/80 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#131b2e] border-b border-slate-800/80 text-slate-400 uppercase tracking-wider font-semibold select-none">
                    <tr>
                      {/* Checkbox Header */}
                      <th className="py-3 px-4 w-10 text-center">
                        <button
                          onClick={() => handleSelectAllFiltered(filteredDevices)}
                          className="text-slate-400 hover:text-white transition focus:outline-none"
                          title={isAllFilteredSelected ? "Batal pilih semua" : "Pilih semua yang difilter"}
                        >
                          {isAllFilteredSelected ? (
                            <CheckSquare className="w-4 h-4 text-indigo-400" />
                          ) : isSomeFilteredSelected ? (
                            <MinusSquare className="w-4 h-4 text-indigo-400" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </th>

                      {/* Status Column */}
                      <th 
                        onClick={() => { setSortField('status'); setSortAsc(!sortAsc); }}
                        className="py-3 px-4 cursor-pointer hover:text-slate-200 transition"
                      >
                        <div className="flex items-center gap-1">
                          Status {sortField === 'status' && <ArrowUpDown className="w-3 h-3 text-indigo-400" />}
                        </div>
                      </th>

                      {/* Device / Hostname */}
                      <th 
                        onClick={() => { setSortField('hostname'); setSortAsc(!sortAsc); }}
                        className="py-3 px-4 cursor-pointer hover:text-slate-200 transition"
                      >
                        <div className="flex items-center gap-1">
                          Device & Hostname {sortField === 'hostname' && <ArrowUpDown className="w-3 h-3 text-indigo-400" />}
                        </div>
                      </th>

                      {/* IP & MAC & Group */}
                      <th 
                        onClick={() => { setSortField('ip'); setSortAsc(!sortAsc); }}
                        className="py-3 px-4 cursor-pointer hover:text-slate-200 transition"
                      >
                        <div className="flex items-center gap-1">
                          Network (IP / MAC) {sortField === 'ip' && <ArrowUpDown className="w-3 h-3 text-indigo-400" />}
                        </div>
                      </th>

                      {/* USB Printer Model & State */}
                      <th className="py-3 px-4">Printer USB Fisik</th>

                      {/* Ink / Toner */}
                      <th className="py-3 px-4">Level Tinta (CMYK)</th>

                      {/* Telemetry Hardware */}
                      <th 
                        onClick={() => { setSortField('cpu_temp'); setSortAsc(!sortAsc); }}
                        className="py-3 px-4 cursor-pointer hover:text-slate-200 transition"
                      >
                        <div className="flex items-center gap-1">
                          Telemetry STB {sortField === 'cpu_temp' && <ArrowUpDown className="w-3 h-3 text-indigo-400" />}
                        </div>
                      </th>

                      {/* Actions */}
                      <th className="py-3 px-4 text-right">Aksi Cepat</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-800/60">
                    {paginatedDevices.length === 0 ? (
                      <tr>
                        <td colSpan="8" className="py-12 text-center text-slate-500">
                          <AlertCircle className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                          <div className="font-semibold text-slate-300">Tidak ada unit yang sesuai filter</div>
                          <div className="text-[11px] text-slate-500 mt-1">Coba ubah kata kunci pencarian atau reset filter di atas.</div>
                        </td>
                      </tr>
                    ) : (
                      paginatedDevices.map(dev => {
                        const isSelected = selectedIds.includes(dev.id);
                        const isOnline = dev.status === 'online';
                        const isPending = dev.status === 'pending';
                        const isLive = dev.is_connected_live;
                        const toner = dev.toner_cmyk || { k: 100 };
                        const isPrinterStopped = ['stopped', 'error', 'disconnected'].includes(dev.printer_state);

                        return (
                          <tr
                            key={dev.id}
                            onClick={() => loadDeviceDetail(dev)}
                            className={`transition cursor-pointer group ${
                              isSelected 
                                ? 'bg-indigo-950/40 hover:bg-indigo-900/50' 
                                : 'hover:bg-slate-800/50'
                            }`}
                          >
                            {/* Checkbox */}
                            <td 
                              className="py-3.5 px-4 text-center"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleSelect(dev.id);
                              }}
                            >
                              <button className="text-slate-400 hover:text-indigo-400 transition focus:outline-none">
                                {isSelected ? (
                                  <CheckSquare className="w-4 h-4 text-indigo-400" />
                                ) : (
                                  <Square className="w-4 h-4 group-hover:text-slate-300" />
                                )}
                              </button>
                            </td>

                            {/* Status Pill */}
                            <td className="py-3.5 px-4 whitespace-nowrap">
                              <div className="flex items-center gap-2">
                                {isLive ? (
                                  <span className="flex h-2.5 w-2.5 relative" title="Live WebSocket Connection Aktif">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                                  </span>
                                ) : isOnline ? (
                                  <span className="h-2 w-2 rounded-full bg-emerald-500/80" title="Online via Polling / DB" />
                                ) : isPending ? (
                                  <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                                ) : (
                                  <span className="h-2 w-2 rounded-full bg-slate-600" />
                                )}

                                <span className={`text-[11px] font-bold uppercase tracking-tight ${
                                  isOnline ? 'text-emerald-400' : isPending ? 'text-amber-400' : 'text-slate-500'
                                }`}>
                                  {dev.status}
                                </span>
                              </div>
                            </td>

                            {/* ID & Label */}
                            <td className="py-3.5 px-4">
                              <div className="font-bold text-slate-100 group-hover:text-indigo-300 transition">
                                {dev.label || dev.id}
                              </div>
                              <div className="text-[11px] text-slate-400 font-mono">
                                {dev.hostname}.local
                              </div>
                            </td>

                            {/* Network Info (IP, MAC, Group) */}
                            <td className="py-3.5 px-4">
                              <div className="font-mono text-slate-200 text-xs">{dev.ip}</div>
                              <div className="text-[10px] text-slate-400 font-mono">
                                MAC: <span className="text-slate-300">{dev.mac || 'b8:27:eb:--:--:--'}</span>
                              </div>
                              <div className="mt-0.5">
                                <span className="inline-block text-[10px] font-semibold px-2 py-0.2 rounded-md bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                  {dev.group_tag || 'General'}
                                </span>
                              </div>
                            </td>

                            {/* Printer Info */}
                            <td className="py-3.5 px-4 max-w-[200px]">
                              <div className="font-medium text-slate-200 truncate" title={dev.printer_name}>
                                {dev.printer_name}
                              </div>
                              <div className="text-[10px] flex items-center gap-1.5 mt-0.5">
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                  dev.printer_state === 'idle' ? 'bg-emerald-400' :
                                  dev.printer_state === 'printing' ? 'bg-indigo-400 animate-pulse' :
                                  'bg-rose-400'
                                }`} />
                                <span className={`uppercase font-bold ${
                                  isPrinterStopped ? 'text-rose-400' : 'text-slate-400'
                                }`}>
                                  {dev.printer_state}
                                </span>
                                <span className="text-slate-600">•</span>
                                <span className="text-slate-400">{dev.driver_version}</span>
                              </div>
                            </td>

                            {/* Ink Gauges */}
                            <td className="py-3.5 px-4">
                              <div className="flex items-center gap-1.5">
                                {toner.c !== undefined && (
                                  <div className="flex flex-col items-center" title={`Cyan: ${toner.c}%`}>
                                    <div className="w-1.5 h-5 bg-slate-800 rounded-sm overflow-hidden flex flex-col justify-end">
                                      <div className="bg-cyan-400 w-full" style={{ height: `${toner.c}%` }} />
                                    </div>
                                    <span className="text-[8px] text-slate-400 mt-0.5">C</span>
                                  </div>
                                )}
                                {toner.m !== undefined && (
                                  <div className="flex flex-col items-center" title={`Magenta: ${toner.m}%`}>
                                    <div className="w-1.5 h-5 bg-slate-800 rounded-sm overflow-hidden flex flex-col justify-end">
                                      <div className="bg-pink-500 w-full" style={{ height: `${toner.m}%` }} />
                                    </div>
                                    <span className="text-[8px] text-slate-400 mt-0.5">M</span>
                                  </div>
                                )}
                                {toner.y !== undefined && (
                                  <div className="flex flex-col items-center" title={`Yellow: ${toner.y}%`}>
                                    <div className="w-1.5 h-5 bg-slate-800 rounded-sm overflow-hidden flex flex-col justify-end">
                                      <div className="bg-amber-300 w-full" style={{ height: `${toner.y}%` }} />
                                    </div>
                                    <span className="text-[8px] text-slate-400 mt-0.5">Y</span>
                                  </div>
                                )}
                                {toner.k !== undefined && (
                                  <div className="flex flex-col items-center" title={`Black: ${toner.k}%`}>
                                    <div className="w-1.5 h-5 bg-slate-800 rounded-sm overflow-hidden flex flex-col justify-end">
                                      <div className="bg-slate-300 w-full" style={{ height: `${toner.k}%` }} />
                                    </div>
                                    <span className="text-[8px] text-slate-400 mt-0.5">K</span>
                                  </div>
                                )}
                                <span className="text-[10px] text-slate-400 ml-1.5 font-mono">
                                  {dev.jobs_completed} jobs
                                </span>
                              </div>
                            </td>

                            {/* Telemetry Hardware */}
                            <td className="py-3.5 px-4 whitespace-nowrap">
                              <div className="text-[11px] text-slate-300 flex items-center gap-1.5">
                                <Cpu className="w-3 h-3 text-slate-400" />
                                <span className={dev.cpu_temp > 65 ? 'text-rose-400 font-bold' : 'text-slate-300'}>
                                  {dev.cpu_temp > 0 ? `${dev.cpu_temp}°C` : '—'}
                                </span>
                                <span className="text-slate-600">•</span>
                                <span className="font-mono">{dev.ram_used_mb > 0 ? `${Math.round(dev.ram_used_mb)} MB` : '—'}</span>
                              </div>
                              <div className="text-[10px] text-slate-500 mt-0.5">Up: {dev.uptime}</div>
                            </td>

                            {/* Quick Action Buttons */}
                            <td 
                              className="py-3.5 px-4 text-right whitespace-nowrap"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {isPending ? (
                                <button
                                  onClick={() => setAdoptModal(dev)}
                                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/20 transition"
                                >
                                  Otorisasi / Adopt
                                </button>
                              ) : (
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    onClick={() => handleDeviceAction(dev.id, 'test_print', 'Test Print')}
                                    disabled={actionLoading[dev.id] || !isOnline}
                                    className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700/80 transition disabled:opacity-30"
                                    title="Kirim Tes Print Langsung"
                                  >
                                    {actionLoading[dev.id] === 'test_print' ? 'Printing...' : 'Test Print'}
                                  </button>
                                  <button
                                    onClick={() => handleDeviceAction(dev.id, 'restart_cups', 'Restart Spooler')}
                                    disabled={actionLoading[dev.id] || !isOnline}
                                    className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700/80 transition disabled:opacity-30"
                                    title="Restart CUPS Daemon"
                                  >
                                    {actionLoading[dev.id] === 'restart_cups' ? 'Restarting...' : 'Restart'}
                                  </button>
                                  <button
                                    onClick={() => loadDeviceDetail(dev)}
                                    className="p-1 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 transition"
                                    title="Buka Rich Detail Drawer"
                                  >
                                    <ChevronRight className="w-4 h-4" />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination Bar */}
              <div className="bg-[#101728] border-t border-slate-800 px-4 py-3 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <span>Baris per halaman:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(e.target.value === 'All' ? 'All' : Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    className="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-slate-200 focus:outline-none"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value="All">Semua ({sortedDevices.length})</option>
                  </select>
                  <span className="text-slate-500">|</span>
                  <span>
                    Menampilkan <strong className="text-slate-200">
                      {sortedDevices.length === 0 ? 0 : (currentPage - 1) * (pageSize === 'All' ? 1 : pageSize) + 1}
                    </strong> - <strong className="text-slate-200">
                      {pageSize === 'All' ? sortedDevices.length : Math.min(currentPage * pageSize, sortedDevices.length)}
                    </strong> dari <strong className="text-slate-200">{sortedDevices.length}</strong> unit
                  </span>
                </div>

                {/* Page Navigation */}
                {pageSize !== 'All' && totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition"
                      title="Halaman Pertama"
                    >
                      <ChevronsLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition"
                      title="Sebelumnya"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>

                    <span className="px-3 py-1 font-semibold text-indigo-400 bg-indigo-500/10 rounded-lg border border-indigo-500/20">
                      Hal {currentPage} / {totalPages}
                    </span>

                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition"
                      title="Berikutnya"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage === totalPages}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition"
                      title="Halaman Terakhir"
                    >
                      <ChevronsRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 2: DRIVER REGISTRY & PUSH */}
        {/* ============================================================ */}
        {activeTab === 'drivers' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#0f172a]/90 p-5 rounded-2xl border border-slate-800 shadow-xl">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <HardDrive className="w-5 h-5 text-indigo-400" />
                  Central Driver Registry & Zero-Config Deployment
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Arsip terpusat paket binary CUPS driver (PPD + Filter ARM64) untuk didistribusikan langsung ke 600 STB printer.
                </p>
              </div>
              <button 
                onClick={() => addToast('Upload driver aktif via drop folder ./console/drivers', 'info')}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition shadow-lg shadow-indigo-600/25"
              >
                <Plus className="w-3.5 h-3.5" /> Unggah Driver Baru (.tar.gz)
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {drivers.map(d => (
                <div key={d.id} className="bg-[#0f172a]/90 p-5 rounded-2xl border border-slate-800 flex flex-col justify-between space-y-4 hover:border-slate-700 transition shadow-xl">
                  <div>
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-bold text-slate-100 text-sm">{d.name}</h3>
                        <div className="text-xs text-indigo-400 font-mono mt-0.5">
                          Versi: {d.version} • Arch: <span className="uppercase">{d.arch}</span>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700">
                        {Math.round(d.file_size / 1024)} KB
                      </span>
                    </div>

                    <div className="mt-3 text-xs text-slate-300 bg-slate-900/60 p-2.5 rounded-xl border border-slate-800">
                      <span className="text-slate-400 block text-[10px] uppercase tracking-wider font-semibold">Target Printer Models:</span>
                      <div className="mt-0.5 font-medium">{d.target_models}</div>
                    </div>

                    <div className="mt-2 text-[10px] text-slate-400 font-mono truncate">
                      SHA256: <span className="text-slate-300">{d.sha256}</span>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                    <span className="text-xs text-slate-400">
                      Telah di-deploy ke <strong className="text-emerald-400">{d.deploy_count}</strong> unit
                    </span>
                    <button
                      onClick={() => {
                        setDeployModal(d);
                        setDeployTarget('All');
                      }}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition shadow-lg shadow-emerald-600/25"
                    >
                      <Send className="w-3.5 h-3.5" /> Deploy ke Armada
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 3: PENDING ADOPTION */}
        {/* ============================================================ */}
        {activeTab === 'pending' && (
          <div className="space-y-6">
            <div className="bg-[#0f172a]/90 p-5 rounded-2xl border border-slate-800 shadow-xl">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Clock className="w-5 h-5 text-amber-400" />
                Pending Device Adoption Queue
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Perangkat STB printer baru yang terhubung ke LAN dan meminta otorisasi bergabung ke cluster HeykPrint.
              </p>
            </div>

            {pendingDevices.length === 0 ? (
              <div className="bg-[#0f172a]/60 border border-slate-800 rounded-2xl p-12 text-center text-slate-400 shadow-xl">
                <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-400 mb-2.5 opacity-90" />
                <p className="font-bold text-slate-100 text-sm">Seluruh Armada Terverifikasi</p>
                <p className="text-xs text-slate-400 mt-1">Tidak ada unit baru yang menunggu otorisasi administrator saat ini.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {pendingDevices.map(dev => (
                  <div key={dev.id} className="bg-[#0f172a] p-5 rounded-2xl border border-amber-500/40 space-y-4 shadow-xl">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-bold text-white text-sm">{dev.id}</div>
                        <div className="text-xs font-mono text-slate-400">{dev.ip} • MAC: {dev.mac || 'b8:27:eb:--'}</div>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                        Menunggu Otorisasi
                      </span>
                    </div>

                    <div className="text-xs text-slate-300 space-y-1 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
                      <div>Printer Terdeteksi: <strong className="text-white">{dev.printer_name}</strong></div>
                      <div>Suhu: {dev.cpu_temp}°C | RAM: {Math.round(dev.ram_used_mb)} MB</div>
                    </div>

                    <button
                      onClick={() => setAdoptModal(dev)}
                      className="w-full py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition shadow-lg shadow-indigo-600/25"
                    >
                      Beri Label & Setujui
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 4: ZERO-TOUCH & OPTION 43 */}
        {/* ============================================================ */}
        {activeTab === 'network' && (
          <div className="space-y-6 max-w-4xl">
            <div className="bg-[#0f172a]/90 p-5 rounded-2xl border border-slate-800 shadow-xl">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-indigo-400" />
                Zero-Touch Provisioning Architecture (600 Appliance Target)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Protokol auto-discovery yang memungkinkan 600 STB di seluruh cabang langsung terkonfigurasi saat dicolokkan ke stopkontak & LAN.
              </p>
            </div>

            <div className="bg-[#0f172a]/80 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
              <h3 className="text-sm font-bold text-indigo-400 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4" /> 1. Auto-Discovery via DHCP Option 43 (Standard Enterprise)
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                Di switch/router inti (Mikrotik, Cisco, pfSense, atau Windows Server DHCP), masukkan Option 43 pada subnet printer kasir:
              </p>
              <div className="bg-slate-950 p-3.5 rounded-xl font-mono text-xs text-emerald-400 border border-slate-800">
                # Contoh Mikrotik RouterOS Command:<br/>
                /ip dhcp-server option add name=heykprint_console code=43 value="'http://{window.location.hostname}:8080'"<br/>
                /ip dhcp-server option sets add name=printer_options options=heykprint_console
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Teknisi lapangan cukup mencolokkan kabel LAN dan power STB. STB membaca Option 43, mengunduh certificate, dan langsung muncul di tab "Pending Adoption" untuk diotorisasi.
              </p>
            </div>

            <div className="bg-[#0f172a]/80 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
              <h3 className="text-sm font-bold text-indigo-400 flex items-center gap-2">
                <Laptop className="w-4 h-4" /> 2. OSD HDMI Direct Configuration
              </h3>
              <p className="text-xs text-slate-300">
                Jika jaringan tertutup tidak mengizinkan kustomisasi DHCP Option, teknisi dapat memasukkan parameter server melalui antarmuka layar HDMI:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800">
                  <span className="text-slate-400 block text-[10px]">MANAGEMENT CONSOLE URL:</span>
                  <span className="text-indigo-300 font-semibold">http://{window.location.hostname}:8080</span>
                </div>
                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800">
                  <span className="text-slate-400 block text-[10px]">ENROLLMENT TOKEN:</span>
                  <span className="text-emerald-400 font-semibold">CORP-PROD-2026</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ============================================================ */}
      {/* RICH DETAIL DRAWER / SLIDE-OVER (Enterprise Specs) */}
      {/* ============================================================ */}
      {detailDrawerDevice && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex justify-end transition-opacity animate-in fade-in duration-200">
          <div 
            className="w-full max-w-2xl bg-[#0d1322] border-l border-slate-800 h-full flex flex-col shadow-2xl overflow-hidden animate-in slide-in-from-right duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="p-5 border-b border-slate-800 bg-[#111827] flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-extrabold text-base text-white">{detailDrawerDevice.label || detailDrawerDevice.id}</span>
                  <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${
                    detailDrawerDevice.status === 'online' 
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' 
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}>
                    {detailDrawerDevice.status}
                  </span>
                  {detailDrawerDevice.is_connected_live && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live WS
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 font-mono mt-1 flex items-center gap-3">
                  <span>Hostname: <strong className="text-slate-200">{detailDrawerDevice.hostname}.local</strong></span>
                  <span>•</span>
                  <span>IP: <strong className="text-slate-200">{detailDrawerDevice.ip}</strong></span>
                  <span>•</span>
                  <span>MAC: <strong className="text-indigo-300">{detailDrawerDevice.mac || 'b8:27:eb:--'}</strong></span>
                </div>
              </div>

              <button
                onClick={() => setDetailDrawerDevice(null)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drawer Quick Action Buttons */}
            <div className="px-5 py-2.5 bg-slate-900/60 border-b border-slate-800/80 flex items-center justify-between gap-2 overflow-x-auto">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDeviceAction(detailDrawerDevice.id, 'test_print', 'Test Print')}
                  disabled={actionLoading[detailDrawerDevice.id] || detailDrawerDevice.status !== 'online'}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/25 transition disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>{actionLoading[detailDrawerDevice.id] === 'test_print' ? 'Mencetak...' : 'Test Print'}</span>
                </button>

                <button
                  onClick={() => handleDeviceAction(detailDrawerDevice.id, 'restart_cups', 'Restart Spooler')}
                  disabled={actionLoading[detailDrawerDevice.id] || detailDrawerDevice.status !== 'online'}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition disabled:opacity-40 flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${actionLoading[detailDrawerDevice.id] === 'restart_cups' ? 'animate-spin' : ''}`} />
                  <span>Restart Spooler</span>
                </button>
              </div>

              <button
                onClick={() => handleClearSingleDeviceJobs(detailDrawerDevice.id)}
                disabled={actionLoading[detailDrawerDevice.id] === 'clear_jobs'}
                className="px-3 py-1.5 rounded-lg bg-rose-900/40 hover:bg-rose-800/60 text-rose-300 text-xs font-semibold border border-rose-700/60 transition flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                <span>Clear Stuck Jobs</span>
              </button>
            </div>

            {/* Drawer Tabs Header */}
            <div className="flex items-center border-b border-slate-800 bg-[#0c1220] px-5">
              {[
                { id: 'telemetry', label: 'Hardware & Printer', icon: Cpu },
                { id: 'queue', label: `Print Queue (${detailData?.queue?.total_active || 0})`, icon: Layers },
                { id: 'logs', label: 'Raw Log Stream', icon: Terminal },
                { id: 'config', label: 'Config & Info', icon: Settings }
              ].map(t => {
                const Icon = t.icon;
                const isActive = detailTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setDetailTab(t.id)}
                    className={`flex items-center gap-1.5 py-3 px-3 text-xs font-semibold border-b-2 transition ${
                      isActive 
                        ? 'border-indigo-500 text-indigo-400 font-bold' 
                        : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Drawer Tab Contents */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {detailLoading ? (
                <div className="py-16 text-center text-slate-400">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-400 mb-2" />
                  <p className="text-xs">Mengambil telemetry hardware dan antrean CUPS...</p>
                </div>
              ) : (
                <>
                  {/* TAB: HARDWARE & TELEMETRY */}
                  {detailTab === 'telemetry' && (
                    <div className="space-y-4">
                      {/* Hardware Stats Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                        <div className="bg-slate-900/90 p-3.5 rounded-xl border border-slate-800">
                          <span className="text-slate-400 block text-[10px] uppercase font-semibold">Suhu CPU</span>
                          <span className={`text-base font-extrabold ${
                            detailDrawerDevice.cpu_temp > 65 ? 'text-rose-400' : 'text-emerald-400'
                          }`}>
                            {detailDrawerDevice.cpu_temp > 0 ? `${detailDrawerDevice.cpu_temp}°C` : 'N/A'}
                          </span>
                          <span className="text-[10px] text-slate-500 block mt-0.5">
                            {detailDrawerDevice.cpu_temp > 65 ? 'Warning: Hangat' : 'Status: Normal'}
                          </span>
                        </div>

                        <div className="bg-slate-900/90 p-3.5 rounded-xl border border-slate-800">
                          <span className="text-slate-400 block text-[10px] uppercase font-semibold">RAM Terpakai</span>
                          <span className="text-base font-extrabold text-slate-100">
                            {Math.round(detailDrawerDevice.ram_used_mb || 250)} MB
                          </span>
                          <span className="text-[10px] text-slate-400 block mt-0.5 font-mono">
                            / {Math.round(detailDrawerDevice.ram_total_mb || 1918)} MB
                          </span>
                        </div>

                        <div className="bg-slate-900/90 p-3.5 rounded-xl border border-slate-800">
                          <span className="text-slate-400 block text-[10px] uppercase font-semibold">Uptime STB</span>
                          <span className="text-base font-extrabold text-indigo-300">
                            {detailDrawerDevice.uptime || '0m'}
                          </span>
                          <span className="text-[10px] text-slate-500 block mt-0.5">Since Boot</span>
                        </div>

                        <div className="bg-slate-900/90 p-3.5 rounded-xl border border-slate-800">
                          <span className="text-slate-400 block text-[10px] uppercase font-semibold">Jobs Selesai</span>
                          <span className="text-base font-extrabold text-white">
                            {detailDrawerDevice.jobs_completed || 0}
                          </span>
                          <span className="text-[10px] text-slate-500 block mt-0.5">Dokumen dicetak</span>
                        </div>
                      </div>

                      {/* RAM Usage Visual Gauge */}
                      <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-800 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                            <Activity className="w-3.5 h-3.5 text-indigo-400" /> Penggunaan Memori RAM
                          </span>
                          <span className="font-mono text-indigo-400">
                            {Math.round(((detailDrawerDevice.ram_used_mb || 250) / (detailDrawerDevice.ram_total_mb || 1918)) * 100)}%
                          </span>
                        </div>
                        <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                          <div 
                            className="bg-gradient-to-r from-indigo-500 to-violet-500 h-full transition-all duration-500"
                            style={{ width: `${Math.min(100, Math.round(((detailDrawerDevice.ram_used_mb || 250) / (detailDrawerDevice.ram_total_mb || 1918)) * 100))}%` }}
                          />
                        </div>
                      </div>

                      {/* Storage Tiering & Flash Endurance Protection */}
                      {(() => {
                        let st = null;
                        try {
                          if (detailDrawerDevice.storage_info) {
                            st = typeof detailDrawerDevice.storage_info === 'string' 
                              ? JSON.parse(detailDrawerDevice.storage_info) 
                              : detailDrawerDevice.storage_info;
                          }
                        } catch {}

                        return (
                          <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-800 space-y-3">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                                <HardDrive className="w-3.5 h-3.5 text-emerald-400" /> Storage Tiering & Flash Protection
                              </span>
                              {st?.microsd?.mounted ? (
                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  <ShieldCheck className="w-3 h-3" /> eMMC Wear Protected
                                </span>
                              ) : (
                                <span className="text-[10px] text-amber-400">eMMC Direct</span>
                              )}
                            </div>

                            <div className="grid grid-cols-2 gap-3 text-xs">
                              <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
                                <div className="flex justify-between text-[11px] text-slate-300 mb-1">
                                  <span>Internal eMMC</span>
                                  <span className="font-mono text-slate-400">{st?.emmc?.percent || 43}%</span>
                                </div>
                                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mb-1">
                                  <div className="bg-indigo-400 h-full" style={{ width: `${st?.emmc?.percent || 43}%` }} />
                                </div>
                                <div className="text-[10px] text-slate-500 flex justify-between">
                                  <span>OS Read-Mostly</span>
                                  <span>{Math.round((st?.emmc?.freeMb || 3300) / 1024 * 10) / 10} GB Free</span>
                                </div>
                              </div>

                              <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
                                <div className="flex justify-between text-[11px] text-slate-300 mb-1">
                                  <span>MicroSD Offload</span>
                                  <span className="font-mono text-emerald-400">{st?.microsd?.percent || 0}%</span>
                                </div>
                                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mb-1">
                                  <div className="bg-emerald-400 h-full" style={{ width: `${Math.max(2, st?.microsd?.percent || 0)}%` }} />
                                </div>
                                <div className="text-[10px] text-slate-500 flex justify-between">
                                  <span>Spool & Scans</span>
                                  <span>{st?.microsd?.freeGb || 57.1} GB Free</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Attached Printer Info Card */}
                      <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-800 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                            <Printer className="w-4 h-4 text-indigo-400" /> USB Printer Details
                          </span>
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                            detailDrawerDevice.printer_state === 'idle' ? 'bg-emerald-500/20 text-emerald-300' :
                            detailDrawerDevice.printer_state === 'printing' ? 'bg-indigo-500/20 text-indigo-300 animate-pulse' :
                            'bg-rose-500/20 text-rose-300'
                          }`}>
                            State: {detailDrawerDevice.printer_state}
                          </span>
                        </div>

                        <div className="text-xs space-y-2">
                          <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                            <span className="text-slate-400">Nama Model:</span>
                            <span className="font-semibold text-white">{detailDrawerDevice.printer_name}</span>
                          </div>
                          <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                            <span className="text-slate-400">USB Device URI:</span>
                            <span className="font-mono text-[11px] text-slate-300 truncate max-w-[320px]" title={detailDrawerDevice.printer_uri}>
                              {detailDrawerDevice.printer_uri || 'usb://local'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                            <span className="text-slate-400">CUPS Driver:</span>
                            <span className="text-slate-200">{detailDrawerDevice.driver_version}</span>
                          </div>
                        </div>

                        {/* Ink / Toner Detailed Bars */}
                        <div className="pt-2">
                          <span className="text-[11px] font-semibold text-slate-400 block mb-2">
                            Level Tinta / Toner Fisik:
                          </span>
                          <div className="grid grid-cols-4 gap-2">
                            {['c', 'm', 'y', 'k'].map(ink => {
                              const toner = detailDrawerDevice.toner_cmyk || {};
                              const val = toner[ink] !== undefined ? toner[ink] : 100;
                              const colors = {
                                c: { name: 'Cyan', bg: 'bg-cyan-400', border: 'border-cyan-400/40' },
                                m: { name: 'Magenta', bg: 'bg-pink-500', border: 'border-pink-500/40' },
                                y: { name: 'Yellow', bg: 'bg-amber-300', border: 'border-amber-300/40' },
                                k: { name: 'Black', bg: 'bg-slate-300', border: 'border-slate-400/40' }
                              };
                              const conf = colors[ink];
                              return (
                                <div key={ink} className="bg-slate-950 p-2 rounded-lg border border-slate-800 text-center">
                                  <div className="text-[10px] text-slate-400 font-semibold">{conf.name}</div>
                                  <div className="font-extrabold text-sm text-slate-100 my-1">{val}%</div>
                                  <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                    <div className={`${conf.bg} h-full`} style={{ width: `${val}%` }} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB: PRINT QUEUE */}
                  {detailTab === 'queue' && (
                    <div className="space-y-4">
                      {/* Active & Pending Job Alert */}
                      <div className="flex items-center justify-between bg-slate-900 p-4 rounded-xl border border-slate-800">
                        <div>
                          <div className="font-bold text-white text-xs">Status Antrean Spooler</div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            {detailData?.queue?.active_job ? 'Sedang mencetak dokumen...' : 'Spooler siap & tidak ada antrean macet'}
                          </div>
                        </div>

                        <button
                          onClick={() => handleClearSingleDeviceJobs(detailDrawerDevice.id)}
                          className="px-3 py-1.5 rounded-lg bg-rose-900/50 hover:bg-rose-800 text-rose-200 text-xs font-semibold border border-rose-700/60 transition flex items-center gap-1.5"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Cancel All / Clear Queue</span>
                        </button>
                      </div>

                      {/* Active Job Card */}
                      {detailData?.queue?.active_job && (
                        <div className="p-3.5 rounded-xl bg-indigo-950/40 border border-indigo-500/40 space-y-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-bold text-indigo-300 flex items-center gap-1.5">
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Active Spool Job
                            </span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-900/60 text-indigo-200">
                              {detailData.queue.active_job.id}
                            </span>
                          </div>
                          <div className="text-xs text-white font-semibold">
                            {detailData.queue.active_job.title}
                          </div>
                          <div className="text-[11px] text-slate-400 flex items-center gap-3">
                            <span>Halaman: {detailData.queue.active_job.pages} hal</span>
                            <span>Ukuran: {detailData.queue.active_job.size_kb} KB</span>
                            <span>User: {detailData.queue.active_job.user}</span>
                          </div>
                        </div>
                      )}

                      {/* Pending Jobs List */}
                      <div>
                        <div className="text-xs font-bold text-slate-300 mb-2">
                          Pending Jobs ({detailData?.queue?.pending_jobs?.length || 0}):
                        </div>
                        {(!detailData?.queue?.pending_jobs || detailData.queue.pending_jobs.length === 0) ? (
                          <div className="text-center py-6 bg-slate-900/40 rounded-xl border border-slate-800 text-slate-500 text-xs">
                            Tidak ada antrean pending.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {detailData.queue.pending_jobs.map(job => (
                              <div key={job.id} className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between text-xs">
                                <div>
                                  <div className="font-semibold text-slate-200">{job.title}</div>
                                  <div className="text-[11px] text-slate-400 font-mono">
                                    {job.id} • {job.pages} Hal • {job.size_kb} KB
                                  </div>
                                </div>
                                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                  Menunggu
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Recent Completed Jobs */}
                      <div>
                        <div className="text-xs font-bold text-slate-300 mb-2">Riwayat Pekerjaan Selesai:</div>
                        <div className="space-y-1.5">
                          {(detailData?.queue?.completed_jobs || []).map(job => (
                            <div key={job.id} className="p-2.5 rounded-lg bg-slate-900/50 border border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                              <div className="flex items-center gap-2">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                <span className="text-slate-200 font-medium">{job.title}</span>
                              </div>
                              <div className="text-[11px] font-mono text-slate-400">
                                {job.pages} hal • Selesai
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB: RAW LOG STREAM */}
                  {detailTab === 'logs' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="relative flex-1">
                          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            placeholder="Filter log (cupsd, usb, kernel, error)..."
                            value={logFilter}
                            onChange={(e) => setLogFilter(e.target.value)}
                            className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-200 focus:outline-none"
                          />
                        </div>

                        <button
                          onClick={() => {
                            const text = (detailData?.logs || []).map(l => `[${l.timestamp}] [${l.level}] [${l.source}]: ${l.message}`).join('\n');
                            navigator.clipboard.writeText(text);
                            addToast('Log aktivitas disalin ke clipboard!', 'success');
                          }}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition"
                          title="Salin Log"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          <span>Salin</span>
                        </button>

                        <button
                          onClick={() => setLogAutoScroll(p => !p)}
                          className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                            logAutoScroll ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          Auto-Scroll
                        </button>
                      </div>

                      {/* Log Terminal Container */}
                      <div 
                        ref={logContainerRef}
                        className="bg-slate-950 border border-slate-800 rounded-xl p-3 h-80 overflow-y-auto font-mono text-[11px] space-y-1.5 scrollbar-thin"
                      >
                        {(detailData?.logs || [])
                          .filter(l => !logFilter || l.message.toLowerCase().includes(logFilter.toLowerCase()) || l.source.toLowerCase().includes(logFilter.toLowerCase()))
                          .map((log, i) => (
                            <div key={i} className="leading-relaxed flex items-start gap-2">
                              <span className="text-slate-500 select-none">{new Date(log.timestamp).toLocaleTimeString()}</span>
                              <span className={`px-1 py-0.2 rounded text-[9px] font-bold ${
                                log.level === 'WARN' ? 'bg-amber-500/20 text-amber-300' :
                                log.level === 'ERROR' ? 'bg-rose-500/20 text-rose-300' :
                                'bg-emerald-500/20 text-emerald-300'
                              }`}>
                                {log.level}
                              </span>
                              <span className="text-indigo-400 font-bold">[{log.source}]</span>
                              <span className="text-slate-300">{log.message}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* TAB: CONFIG & INFO */}
                  {detailTab === 'config' && (
                    <div className="space-y-4 text-xs">
                      <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-800 space-y-2.5">
                        <div className="font-bold text-white text-sm">System & Kernel Architecture</div>
                        <div className="grid grid-cols-2 gap-2 text-slate-300">
                          <div>Arsitektur CPU:</div>
                          <div className="font-mono text-indigo-400">{detailData?.device?.hardware?.arch || 'aarch64'}</div>
                          <div>Versi Linux Kernel:</div>
                          <div className="font-mono text-slate-200">{detailData?.device?.hardware?.kernel || 'Linux 6.6 aarch64'}</div>
                          <div>CUPS Spooler Engine:</div>
                          <div className="font-mono text-slate-200">{detailData?.device?.hardware?.cups_version || 'CUPS 2.4.2'}</div>
                          <div>Penyimpanan Flash:</div>
                          <div className="font-mono text-slate-200">3.4 GB / 14.8 GB (eMMC)</div>
                        </div>
                      </div>

                      <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-800 space-y-2.5">
                        <div className="font-bold text-white text-sm">Identitas Perangkat Jaringan</div>
                        <div className="grid grid-cols-2 gap-2 text-slate-300">
                          <div>MAC Address Fisik:</div>
                          <div className="font-mono text-emerald-400 font-bold">{detailDrawerDevice.mac || 'b8:27:eb:8f:2b:01'}</div>
                          <div>Alamat IP:</div>
                          <div className="font-mono text-slate-200">{detailDrawerDevice.ip}</div>
                          <div>Group Tag:</div>
                          <div className="font-semibold text-indigo-300">{detailDrawerDevice.group_tag}</div>
                          <div>Enrolled Token:</div>
                          <div className="font-mono text-slate-400">{detailDrawerDevice.auth_token || 'CORP-PROD-2026'}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MODAL: ASSIGN GROUP */}
      {/* ============================================================ */}
      {assignGroupModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0f172a] border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="font-bold text-base text-white flex items-center gap-2">
              <Tag className="w-5 h-5 text-indigo-400" /> Pindahkan Grup Unit
            </h3>
            <p className="text-xs text-slate-400">
              Ubah penugasan cabang / grup lokasi untuk <strong className="text-white">{selectedIds.length}</strong> unit yang dipilih.
            </p>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1.5">Pilih Grup Tersedia:</label>
                <div className="grid grid-cols-2 gap-2">
                  {['Jakarta', 'Surabaya', 'Gudang', 'Bandung', 'Medan', 'General'].map(g => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => {
                        setTargetGroupName(g);
                        setCustomGroupInput('');
                      }}
                      className={`p-2 rounded-xl text-xs font-semibold border transition ${
                        targetGroupName === g && !customGroupInput
                          ? 'bg-indigo-600 border-indigo-500 text-white shadow-md'
                          : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Atau Buat Grup Baru:</label>
                <input
                  type="text"
                  placeholder="Contoh: Semarang, Kasir VIP..."
                  value={customGroupInput}
                  onChange={(e) => setCustomGroupInput(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAssignGroupModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold transition"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleApplyAssignGroup}
                  disabled={!!batchActionLoading}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition shadow-lg shadow-indigo-600/25 flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" /> Simpan Perubahan
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MODAL: ADOPT DEVICE */}
      {/* ============================================================ */}
      {adoptModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0f172a] border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="font-bold text-base text-white">Otorisasi & Adopsi Perangkat STB</h3>
            <p className="text-xs text-slate-400">
              Perangkat <strong className="text-indigo-400 font-mono">{adoptModal.id}</strong> di IP <strong className="text-slate-200">{adoptModal.ip}</strong> akan diizinkan bergabung ke armada manajemen.
            </p>

            <form onSubmit={handleAdoptDevice} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Label Lokasi / Nama Unit</label>
                <input
                  name="label"
                  defaultValue={`Kasir - ${adoptModal.id}`}
                  required
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Grup / Cabang</label>
                <select
                  name="group_tag"
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-indigo-500"
                >
                  <option value="Jakarta">Jakarta</option>
                  <option value="Surabaya">Surabaya</option>
                  <option value="Gudang">Gudang</option>
                  <option value="General">General</option>
                </select>
              </div>

              <div className="pt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAdoptModal(null)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold transition"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition shadow-lg shadow-indigo-600/25"
                >
                  Setujui & Daftarkan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MODAL: DEPLOY DRIVER */}
      {/* ============================================================ */}
      {deployModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0f172a] border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="font-bold text-base text-white">Deploy Driver ke Armada STB</h3>
            <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800 text-xs space-y-1">
              <div className="font-semibold text-slate-200">{deployModal.name}</div>
              <div className="text-slate-400 font-mono text-[11px]">Versi: {deployModal.version}</div>
              <div className="text-slate-400 text-[11px]">Target: {deployModal.target_models}</div>
            </div>

            <div className="space-y-2 text-xs">
              <label className="block text-slate-300 font-medium">Target Distribusi:</label>
              <select
                value={deployTarget}
                onChange={(e) => setDeployTarget(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-indigo-500"
              >
                {selectedIds.length > 0 && (
                  <option value="Selected">Hanya {selectedIds.length} Unit yang Dipilih di Tabel</option>
                )}
                <option value="All">Seluruh Armada Online ({devices.filter(d => d.status === 'online').length} Unit)</option>
                <option value="Jakarta">Hanya Cabang Jakarta</option>
                <option value="Surabaya">Hanya Cabang Surabaya</option>
                <option value="Gudang">Hanya Cabang Gudang</option>
              </select>
            </div>

            {deployProgress && (
              <div className="p-3 bg-indigo-950/60 border border-indigo-800/80 rounded-xl text-xs text-indigo-300 flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                {deployProgress}
              </div>
            )}

            <div className="pt-2 flex items-center justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => setDeployModal(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold transition"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleDeployDriver}
                disabled={!!deployProgress}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition flex items-center gap-1.5 shadow-lg shadow-emerald-600/25"
              >
                <Send className="w-3.5 h-3.5" /> Push Sekarang
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
