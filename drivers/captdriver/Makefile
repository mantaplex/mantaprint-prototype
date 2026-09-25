CC ?= gcc
CFLAGS ?= -std=c99 -O2 -Wall
CUPS_CFLAGS := $(shell cups-config --cflags 2>/dev/null || echo "")
CUPS_LIBS := $(shell cups-config --libs 2>/dev/null || echo "-lcupsimage -lcups")

SRCS = src/capt-command.c \
       src/capt-status.c \
       src/generic-ops.c \
       src/printer.c \
       src/paper.c \
       src/hiscoa-common.c \
       src/hiscoa-compress.c \
       src/prn_lbp2900.c \
       src/rastertocapt.c

TARGET = rastertocapt
DESTDIR ?=
PREFIX ?= /usr
CUPS_FILTER_DIR ?= $(PREFIX)/lib/cups/filter
CUPS_MODEL_DIR ?= $(PREFIX)/share/cups/model

all: $(TARGET)

$(TARGET): $(SRCS)
	$(CC) $(CFLAGS) $(CUPS_CFLAGS) $(SRCS) -o $(TARGET) $(CUPS_LIBS)

install: $(TARGET)
	install -d -m 755 $(DESTDIR)$(CUPS_FILTER_DIR)
	install -m 755 $(TARGET) $(DESTDIR)$(CUPS_FILTER_DIR)/$(TARGET)
	install -d -m 755 $(DESTDIR)$(CUPS_MODEL_DIR)
	install -m 644 ppd/*.ppd $(DESTDIR)$(CUPS_MODEL_DIR)/

clean:
	rm -f $(TARGET)

.PHONY: all install clean
