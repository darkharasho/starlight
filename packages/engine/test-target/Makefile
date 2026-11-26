CC      ?= gcc
CFLAGS  ?= -O0 -g -Wall -Wextra -fno-pie -no-pie
TARGET  := build/target

.PHONY: all clean
all: $(TARGET) build/target32

$(TARGET): target.c | build
	$(CC) $(CFLAGS) -pthread -o $@ $<

build/target32: target32.c | build
	$(CC) -m32 -O0 -nostdlib -static -fno-pie -no-pie -ffreestanding -o $@ $<

build:
	mkdir -p build

clean:
	rm -rf build
