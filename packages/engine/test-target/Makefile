CC      ?= gcc
CFLAGS  ?= -O0 -g -Wall -Wextra -fno-pie -no-pie
TARGET  := build/target

.PHONY: all clean
all: $(TARGET)

$(TARGET): target.c | build
	$(CC) $(CFLAGS) -pthread -o $@ $<

build:
	mkdir -p build

clean:
	rm -rf build
