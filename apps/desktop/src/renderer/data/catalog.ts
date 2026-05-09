export interface CatalogGame {
  steamAppId: number;
  name: string;
  processName: string[];
  /** Steam CDN library cover (600x900). */
  coverUrl: string;
  hasTrainer: boolean;
  installed: boolean;
}

const cover = (id: number): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`;

export const CATALOG: CatalogGame[] = [
  { steamAppId: 1245620, name: 'Elden Ring',         processName: ['eldenring.exe'],     coverUrl: cover(1245620), hasTrainer: true,  installed: true  },
  { steamAppId: 1091500, name: 'Cyberpunk 2077',     processName: ['Cyberpunk2077.exe'], coverUrl: cover(1091500), hasTrainer: true,  installed: true  },
  { steamAppId: 413150,  name: 'Stardew Valley',     processName: ['Stardew Valley.exe'],coverUrl: cover(413150),  hasTrainer: false, installed: true  },
  { steamAppId: 1145350, name: 'Hades II',           processName: ['Hades2.exe'],        coverUrl: cover(1145350), hasTrainer: true,  installed: false },
  { steamAppId: 367520,  name: 'Hollow Knight',      processName: ['hollow_knight.exe'], coverUrl: cover(367520),  hasTrainer: false, installed: false },
  { steamAppId: 814380,  name: 'Sekiro',             processName: ['sekiro.exe'],        coverUrl: cover(814380),  hasTrainer: false, installed: false },
  { steamAppId: 1086940, name: "Baldur's Gate 3",    processName: ['bg3.exe'],           coverUrl: cover(1086940), hasTrainer: true,  installed: false },
  { steamAppId: 1716740, name: 'Starfield',          processName: ['Starfield.exe'],     coverUrl: cover(1716740), hasTrainer: true,  installed: false },
  { steamAppId: 553850,  name: 'Helldivers 2',       processName: ['helldivers2.exe'],   coverUrl: cover(553850),  hasTrainer: true,  installed: false },
  { steamAppId: 2694490, name: 'Path of Exile 2',    processName: ['PathOfExile.exe'],   coverUrl: cover(2694490), hasTrainer: true,  installed: false },
  { steamAppId: 374320,  name: 'Dark Souls III',     processName: ['DarkSoulsIII.exe'],  coverUrl: cover(374320),  hasTrainer: true,  installed: false },
  { steamAppId: 2050650, name: 'Resident Evil 4',    processName: ['re4.exe'],           coverUrl: cover(2050650), hasTrainer: true,  installed: false },
];
