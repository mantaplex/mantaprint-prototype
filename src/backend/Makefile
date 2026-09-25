CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra -pedantic
LDFLAGS ?= -ldl

TARGET = mantaprint-smart-usb
SRC = mantaprint_smart_usb.c

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) $(SRC) -o $(TARGET) $(LDFLAGS)

clean:
	rm -f $(TARGET)

.PHONY: all clean
