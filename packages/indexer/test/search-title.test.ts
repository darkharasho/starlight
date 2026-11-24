import { describe, it, expect } from 'vitest';
import { normTitle, sameGame, searchTitle } from '../src/search-title.js';

describe('searchTitle', () => {
  it.each([
    ['Among Us (Steam/Epic/Gamepass) (no longer being updated)', 'Among Us'],
    ['Voidborn (Early Access)', 'Voidborn'],
    ['Kingdom Hearts III (Epic Games Store) +43', 'Kingdom Hearts III'],
    ['Strategic Mind The Pacific +7 Table', 'Strategic Mind The Pacific'],
    ['AC Valhalla (Uplay', 'AC Valhalla'],
    ['Cook, Serve, Delicious! 2!! (2017-09-17)', 'Cook, Serve, Delicious! 2!!'],
    ['Baldurs Gate 2 Enhanced Edition 2.6.6.0 x64bit (Godmode,Haste, Gold, Weight)', 'Baldurs Gate 2 Enhanced Edition'],
    ['Control Ultimate Edition Steam 1.13 DX 11', 'Control Ultimate Edition'],
    ['Huntdown Steam+EGS 2021/05/16', 'Huntdown'],
    ['Grandia 2 HD remaster STEAM', 'Grandia 2 HD remaster'],
    ['9 Kings Demo', '9 Kings'],
    ['Cheat Table for Risen (Steam)', 'Risen'],
    ['Doom: The Dark Ages (+24 options) + Gamepass', 'Doom: The Dark Ages'],
    ['Mad Games Tycoon 2 [2022.03.23A] **Updated to March 23, 2022**', 'Mad Games Tycoon 2'],
    ['Football Manager 2024', 'Football Manager 2024'],
    ['Pac-Man Museum+', 'Pac-Man Museum+'],
    ['Black Desert Online', 'Black Desert Online'],
  ])('%s → %s', (raw, want) => {
    expect(searchTitle(raw)).toBe(want);
  });

  it('keeps the title when stripping would leave nothing', () => {
    expect(searchTitle('Demo')).toBe('Demo');
  });
});

describe('sameGame', () => {
  it('ignores case, punctuation, trademark signs, & and roman numerals', () => {
    expect(sameGame('A Plague Tale Innocence', 'A Plague Tale: Innocence')).toBe(true);
    expect(sameGame('Final Fantasy 7 Remake', 'FINAL FANTASY VII REMAKE')).toBe(true);
    expect(sameGame('Ratchet and Clank', 'Ratchet & Clank™')).toBe(true);
    expect(normTitle('Pokémon')).toBe('pokemon');
  });
  it('ignores edition labels on either side', () => {
    expect(sameGame('Batman Arkham City', 'Batman: Arkham City - Game of the Year Edition')).toBe(true);
    expect(sameGame('Borderlands 3 Ultimate Edition', 'Borderlands 3')).toBe(true);
  });
  it('does not match a different game in the series', () => {
    expect(sameGame('Fallout', 'Fallout: New Vegas')).toBe(false);
    expect(sameGame('Dark Souls', 'Dark Souls Remastered')).toBe(false);
    expect(sameGame('Bioshock', 'BioShock 2')).toBe(false);
  });
});

describe('labels found in the live sample', () => {
  it.each([
    ['z Wartales', 'Wartales'],
    ['Gotham Knights table v: 1.0 CT', 'Gotham Knights'],
    ['Crafty Survivors Cheat Engine', 'Crafty Survivors'],
    ['Descenders Next Achievement Unlocker', 'Descenders Next'],
    ['Yakuza Kiwami 2 Remastered AIO', 'Yakuza Kiwami 2 Remastered'],
    ['Grand Theft Auto V', 'Grand Theft Auto V'],
    ['Mycopunk CETable', 'Mycopunk'],
    ['"Danganronpa 2: Goodbye Despair" CE', 'Danganronpa 2: Goodbye Despair'],
    ['Kena: Bridge of Spirits +?', 'Kena: Bridge of Spirits'],
    ['Batman : Arkham Origins', 'Batman: Arkham Origins'],
    ["Assassin's Creed 7 ~ Syndicate ~", "Assassin's Creed 7"],
    ['Megabonk PC', 'Megabonk'],
    ['Mythforce 1.0.2.2-1-g650a03c', 'Mythforce'],
    ['Untitled Goose Game', 'Untitled Goose Game'],
    ['Grand Theft Auto V table v: 1.6 CT', 'Grand Theft Auto V'],
  ])('%s → %s', (raw, want) => { expect(searchTitle(raw)).toBe(want); });

  it('an edition word alone is part of the name', () => {
    expect(sameGame('Crimson Desert', 'Crimson Desert Enhanced')).toBe(false);
  });
});
