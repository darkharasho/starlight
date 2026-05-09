#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { importCt } from './ct-importer.js';

interface CliOpts {
  gameName: string;
  process: string[];
  out?: string;
  steamId?: string;
  platform?: string[];
  sourceUrl?: string;
}

type ImportPlatforms = ('windows' | 'linux' | 'linux-proton' | 'macos')[];

const program = new Command();
program
  .name('starlight-import-ct')
  .description('Convert a Cheat Engine .CT file to a Starlight Trainer JSON')
  .argument('<file>', 'Path to a .CT file')
  .requiredOption('-g, --game-name <name>', 'Display name of the game')
  .requiredOption('-p, --process <names...>', 'Process names that the trainer attaches to (e.g. eldenring.exe)')
  .option('-o, --out <path>', 'Write JSON to this file (otherwise printed to stdout)')
  .option('--steam-id <id>', 'Steam app id')
  .option('--platform <platforms...>', 'Platforms (windows, linux, linux-proton, macos)')
  .option('--source-url <url>', 'Original URL of the .CT file (e.g. fearlessrevolution.com link)')
  .action((file: string, opts: CliOpts) => {
    const xml = readFileSync(file, 'utf8');
    const result = importCt(xml, {
      gameName: opts.gameName,
      processName: opts.process,
      ...(opts.steamId ? { steamAppId: Number(opts.steamId) } : {}),
      ...(opts.platform ? { platform: opts.platform as ImportPlatforms } : {}),
      ...(opts.sourceUrl ? { sourceUrl: opts.sourceUrl } : {}),
    });

    const json = JSON.stringify(result.trainer, null, 2);
    if (opts.out) writeFileSync(opts.out, json);
    else process.stdout.write(json + '\n');

    process.stderr.write(
      `total: ${result.stats.total}\n` +
      `supported: ${result.stats.supported}\n` +
      `unsupported: ${result.stats.unsupported}\n` +
      `categories: ${result.stats.categories}\n`,
    );
  });

program.parse();
