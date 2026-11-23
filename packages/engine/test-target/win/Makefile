# Windows test program for live Proton checks. Needs a mingw-w64 cross compiler.
MINGW_CC ?= x86_64-w64-mingw32-gcc
CFLAGS   ?= -O1 -g -Wall -Wextra
TARGET   := build/clocks.exe

.PHONY: all clean
all: $(TARGET)

$(TARGET): clocks.c | build
	$(MINGW_CC) $(CFLAGS) -mconsole -o $@ $< -lwinmm

build:
	mkdir -p build

clean:
	rm -rf build
