# Windows test programs for live Proton checks. Needs a mingw-w64 cross compiler.
MINGW_CC ?= x86_64-w64-mingw32-gcc
CFLAGS   ?= -O1 -g -Wall -Wextra
TARGETS  := build/clocks.exe build/gold.exe

.PHONY: all clean
all: $(TARGETS)

build/clocks.exe: clocks.c | build
	$(MINGW_CC) $(CFLAGS) -mconsole -o $@ $< -lwinmm

build/gold.exe: gold.c | build
	$(MINGW_CC) $(CFLAGS) -mconsole -o $@ $<

build:
	mkdir -p build

clean:
	rm -rf build
