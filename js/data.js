/* Micro Wars — core data tables (pure JS, no DOM; loadable in node for tests) */
'use strict';

const TERRAIN = {
  PLAIN:    { id: 'PLAIN',    name: 'Plains',   def: 1, move: { foot: 1, boot: 1, tires: 2, treads: 1, air: 1 } },
  WOOD:     { id: 'WOOD',     name: 'Woods',    def: 2, move: { foot: 1, boot: 1, tires: 3, treads: 2, air: 1 }, hides: true },
  MOUNTAIN: { id: 'MOUNTAIN', name: 'Mountain', def: 4, move: { foot: 2, boot: 1, air: 1 }, visionBonus: 3 },
  ROAD:     { id: 'ROAD',     name: 'Road',     def: 0, move: { foot: 1, boot: 1, tires: 1, treads: 1, air: 1 } },
  BRIDGE:   { id: 'BRIDGE',   name: 'Bridge',   def: 0, move: { foot: 1, boot: 1, tires: 1, treads: 1, air: 1 } },
  RIVER:    { id: 'RIVER',    name: 'River',    def: 0, move: { foot: 2, boot: 1, air: 1 } },
  SEA:      { id: 'SEA',      name: 'Sea',      def: 0, move: { air: 1 } },
  SHOAL:    { id: 'SHOAL',    name: 'Shoal',    def: 0, move: { foot: 1, boot: 1, tires: 2, treads: 1, air: 1 } },
  CITY:     { id: 'CITY',     name: 'City',     def: 3, move: { foot: 1, boot: 1, tires: 1, treads: 1, air: 1 }, capturable: true, income: true, repairs: 'land' },
  BASE:     { id: 'BASE',     name: 'Base',     def: 3, move: { foot: 1, boot: 1, tires: 1, treads: 1, air: 1 }, capturable: true, income: true, repairs: 'land', produces: 'land' },
  AIRPORT:  { id: 'AIRPORT',  name: 'Airport',  def: 3, move: { foot: 1, boot: 1, tires: 1, treads: 1, air: 1 }, capturable: true, income: true, repairs: 'air', produces: 'air' },
  HQ:       { id: 'HQ',       name: 'HQ',       def: 4, move: { foot: 1, boot: 1, tires: 1, treads: 1, air: 1 }, capturable: true, income: true, repairs: 'land', hq: true },
};

/* Map file characters -> terrain (+ property owner).
   Owners: uppercase/neutral chars listed here; per-map `owners` overrides. */
const CHAR_TERRAIN = {
  '.': { t: 'PLAIN' },
  'f': { t: 'WOOD' },
  'm': { t: 'MOUNTAIN' },
  'r': { t: 'ROAD' },
  '=': { t: 'BRIDGE' },
  'v': { t: 'RIVER' },
  'w': { t: 'SEA' },
  's': { t: 'SHOAL' },
  'C': { t: 'CITY', owner: -1 },
  'B': { t: 'BASE', owner: -1 },
  'P': { t: 'AIRPORT', owner: -1 },
  '1': { t: 'HQ', owner: 0 },
  '2': { t: 'HQ', owner: 1 },
  'c': { t: 'CITY', owner: 0 },
  'e': { t: 'CITY', owner: 1 },
  'b': { t: 'BASE', owner: 0 },
  'd': { t: 'BASE', owner: 1 },
  'p': { t: 'AIRPORT', owner: 0 },
  'q': { t: 'AIRPORT', owner: 1 },
};

/* Unit types. hp is tracked 0..100 internally, displayed ceil(hp/10). */
const UNITS = {
  INF:     { id: 'INF',     name: 'Infantry',  cost: 1000,  move: 3, cls: 'foot',   range: [1, 1], vision: 2, capture: true },
  MECH:    { id: 'MECH',    name: 'Mech',      cost: 3000,  move: 2, cls: 'boot',   range: [1, 1], vision: 2, capture: true },
  RECON:   { id: 'RECON',   name: 'Recon',     cost: 4000,  move: 8, cls: 'tires',  range: [1, 1], vision: 5 },
  TANK:    { id: 'TANK',    name: 'Tank',      cost: 7000,  move: 6, cls: 'treads', range: [1, 1], vision: 3 },
  MDTANK:  { id: 'MDTANK',  name: 'Md Tank',   cost: 16000, move: 5, cls: 'treads', range: [1, 1], vision: 2 },
  APC:     { id: 'APC',     name: 'APC',       cost: 5000,  move: 6, cls: 'treads', range: [0, 0], vision: 1, carries: ['INF', 'MECH'] },
  ARTY:    { id: 'ARTY',    name: 'Artillery', cost: 6000,  move: 5, cls: 'treads', range: [2, 3], vision: 3, indirect: true },
  ROCKET:  { id: 'ROCKET',  name: 'Rockets',   cost: 15000, move: 5, cls: 'tires',  range: [3, 5], vision: 3, indirect: true },
  AA:      { id: 'AA',      name: 'Anti-Air',  cost: 8000,  move: 6, cls: 'treads', range: [1, 1], vision: 3 },
  FIGHTER: { id: 'FIGHTER', name: 'Fighter',   cost: 20000, move: 9, cls: 'air',    range: [1, 1], vision: 5 },
  BOMBER:  { id: 'BOMBER',  name: 'Bomber',    cost: 22000, move: 7, cls: 'air',    range: [1, 1], vision: 3 },
  BCOPTER: { id: 'BCOPTER', name: 'B-Copter',  cost: 9000,  move: 6, cls: 'air',    range: [1, 1], vision: 4 },
  TCOPTER: { id: 'TCOPTER', name: 'T-Copter',  cost: 5000,  move: 6, cls: 'air',    range: [0, 0], vision: 2, carries: ['INF', 'MECH'] },
};

const UNIT_ORDER = ['INF', 'MECH', 'RECON', 'TANK', 'MDTANK', 'AA', 'ARTY', 'ROCKET', 'APC',
  'BCOPTER', 'TCOPTER', 'FIGHTER', 'BOMBER'];

const AIR_UNITS = new Set(['FIGHTER', 'BOMBER', 'BCOPTER', 'TCOPTER']);

/* Base damage % (attacker -> defender). Missing entry = cannot attack that unit. */
const DAMAGE = {
  INF:     { INF: 55, MECH: 45, RECON: 12, TANK: 5,  MDTANK: 1,  APC: 14,  ARTY: 15,  ROCKET: 25, AA: 5,   BCOPTER: 7,   TCOPTER: 30 },
  MECH:    { INF: 65, MECH: 55, RECON: 85, TANK: 55, MDTANK: 15, APC: 75,  ARTY: 70,  ROCKET: 85, AA: 65,  BCOPTER: 9,   TCOPTER: 35 },
  RECON:   { INF: 70, MECH: 65, RECON: 35, TANK: 6,  MDTANK: 1,  APC: 45,  ARTY: 45,  ROCKET: 55, AA: 4,   BCOPTER: 10,  TCOPTER: 35 },
  TANK:    { INF: 75, MECH: 70, RECON: 85, TANK: 55, MDTANK: 15, APC: 75,  ARTY: 70,  ROCKET: 85, AA: 65,  BCOPTER: 10,  TCOPTER: 40 },
  MDTANK:  { INF: 105, MECH: 95, RECON: 105, TANK: 85, MDTANK: 55, APC: 105, ARTY: 105, ROCKET: 105, AA: 105, BCOPTER: 12, TCOPTER: 45 },
  ARTY:    { INF: 90, MECH: 85, RECON: 80, TANK: 70, MDTANK: 45, APC: 70,  ARTY: 75,  ROCKET: 80, AA: 75 },
  ROCKET:  { INF: 95, MECH: 90, RECON: 90, TANK: 80, MDTANK: 55, APC: 80,  ARTY: 80,  ROCKET: 85, AA: 85 },
  AA:      { INF: 105, MECH: 105, RECON: 60, TANK: 25, MDTANK: 10, APC: 50, ARTY: 50, ROCKET: 55, AA: 45, FIGHTER: 65, BOMBER: 75, BCOPTER: 120, TCOPTER: 120 },
  FIGHTER: { FIGHTER: 55, BOMBER: 100, BCOPTER: 100, TCOPTER: 100 },
  BOMBER:  { INF: 110, MECH: 110, RECON: 105, TANK: 105, MDTANK: 95, APC: 105, ARTY: 105, ROCKET: 105, AA: 95 },
  BCOPTER: { INF: 75, MECH: 75, RECON: 55, TANK: 55, MDTANK: 25, APC: 60, ARTY: 65, ROCKET: 65, AA: 25, BCOPTER: 65, TCOPTER: 95 },
};

const INCOME_PER_PROPERTY = 1000;
const CAPTURE_POINTS = 20;
const REPAIR_HP = 20;          // hp points (2 display HP) repaired per turn on a friendly property
const MAX_HP = 100;

const ARMY = [
  { name: 'Ruby Legion',   color: '#e14b4b', dark: '#8f1f1f', light: '#ff9d9d' },
  { name: 'Cobalt Guard',  color: '#4b7be1', dark: '#1f3f8f', light: '#9dc0ff' },
];

if (typeof module !== 'undefined') {
  module.exports = { TERRAIN, CHAR_TERRAIN, UNITS, UNIT_ORDER, AIR_UNITS, DAMAGE, INCOME_PER_PROPERTY, CAPTURE_POINTS, REPAIR_HP, MAX_HP, ARMY };
}
