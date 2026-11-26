# Windows test programs for live Proton checks. Needs a mingw-w64 cross compiler.
MINGW_CC ?= x86_64-w64-mingw32-gcc
CFLAGS   ?= -O1 -g -Wall -Wextra
MINGW32_CC ?= i686-w64-mingw32-gcc
TARGETS  := build/clocks.exe build/gold.exe build/w32.exe

.PHONY: all clean
all: $(TARGETS)

build/clocks.exe: clocks.c | build
	$(MINGW_CC) $(CFLAGS) -mconsole -o $@ $< -lwinmm

build/gold.exe: gold.c | build
	$(MINGW_CC) $(CFLAGS) -mconsole -o $@ $<

build/w32.exe: w32.c | build
	$(MINGW32_CC) $(CFLAGS) -mconsole -o $@ $<

build:
	mkdir -p build

clean:
	rm -rf build
