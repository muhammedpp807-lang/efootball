import {
  BallState, Difficulty, MatchStats, PassMode, PitchPlayer, RefereeState, Side, Strictness, Team,
} from '../types/game';

/* ================================================================== */
/* PITCH GEOMETRY (world units, USER always attacks +x)                */
/* ================================================================== */
export const PITCH = {
  halfW: 520,
  halfH: 330,
  goalHalf: 80,
  crossbar: 64,
  goalDepth: 50,
  boxW: 165,
  boxH: 215,
  sixW: 62,
  sixH: 112,
  circle: 84,
  penaltySpot: 120,
};
export const BALL_R = 7.5;
export const WORLD = { halfW: 672, halfH: 452 };

export interface DiffProfile {
  speed: number; react: number; tackle: number; passAcc: number;
  shotAcc: number; press: number; keeper: number; aggro: number;
}

export const DIFFICULTY: Record<Difficulty, DiffProfile> = {
  EASY:   { speed: 0.86, react: 0.55, tackle: 0.22, passAcc: 0.70, shotAcc: 0.55, press: 190, keeper: 0.52, aggro: 0.55 },
  NORMAL: { speed: 0.94, react: 0.78, tackle: 0.42, passAcc: 0.82, shotAcc: 0.72, press: 250, keeper: 0.72, aggro: 0.80 },
  HARD:   { speed: 1.02, react: 0.95, tackle: 0.62, passAcc: 0.92, shotAcc: 0.87, press: 330, keeper: 0.88, aggro: 1.00 },
};

const ALLY: DiffProfile = { speed: 0.97, react: 0.85, tackle: 0.46, passAcc: 0.86, shotAcc: 0.74, press: 265, keeper: 0.78, aggro: 0.85 };

const STRICT_FOUL: Record<Strictness, number> = { LENIENT: 0.34, STANDARD: 0.55, STRICT: 0.72 };
const STRICT_CARD: Record<Strictness, number> = { LENIENT: 0.16, STANDARD: 0.3, STRICT: 0.46 };

export type RestartKind = 'THROW' | 'CORNER' | 'GOALKICK' | 'FREEKICK' | 'PENALTY';

export type MatchEvent =
  | { type: 'GOAL'; side: Side; scorer: string; ownGoal: boolean }
  | { type: 'SAVE'; side: Side; caught: boolean }
  | { type: 'POST' }
  | { type: 'SHOT'; side: Side }
  | { type: 'PASS'; side: Side }
  | { type: 'TACKLE'; side: Side }
  | { type: 'RESTART'; kind: RestartKind; side: Side }
  | { type: 'DECISION'; text: string; card: 'YELLOW' | 'RED' | null };

interface Restart {
  type: RestartKind;
  side: Side;
  x: number;
  y: number;
  timer: number;
}

export interface InputState {
  up: boolean; down: boolean; left: boolean; right: boolean; sprint: boolean;
  pointer: { x: number; y: number; active: boolean } | null;
}

export interface World {
  userTeam: Team;
  cpuTeam: Team;
  players: PitchPlayer[];
  referee: RefereeState;
  ball: BallState;
  score: { user: number; cpu: number };
  stats: MatchStats;
  controlledId: string;
  passTargetId: string | null;
  incomingReceiver: string | null;
  diff: DiffProfile;
  restart: Restart | null;
  gkHold: { side: Side; timer: number } | null;
  /** A keeper who has just distributed cannot re-gather his own ball. */
  gkRelease: { id: string; timer: number } | null;
  live: boolean;
  awaitingKickoff: Side | null;
  freeze: number;
  lastTouch: { side: Side; name: string } | null;
  autoSwitch: boolean;
  passMode: PassMode;
  strictness: Strictness;
  events: MatchEvent[];
  pickupCd: number;
  passCd: number;
  tick: number;
  rand: () => number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export const getById = (w: World, id: string | null) =>
  (id ? w.players.find((p) => p.id === id) || null : null);

const active = (w: World) => w.players.filter((p) => !p.sentOff);
const sideIndex = (side: Side) => (side === 'USER' ? 0 : 1);
const dirOf = (side: Side) => (side === 'USER' ? 1 : -1);

const REF_FIRST = ['M. Oyelaran', 'D. Castellano', 'A. Bergström', 'R. Nakamura', 'L. Okafor', 'P. Vasquez'];
const REF_LAST = ['(FIFA)', '(FIFA)', '(FIFA)', '(FIFA)', '(FIFA)', '(FIFA)'];

function homeFor(side: Side, role: PitchPlayer['role']) {
  const dir = dirOf(side);
  const base: Record<string, [number, number]> = {
    GK: [-PITCH.halfW + 34, 0],
    DEF: [-250, 92],
    MID: [-120, -98],
    FWD: [-45, 8],
  };
  const [x, y] = base[role];
  return { x: x * dir, y: y * dir };
}

function makePitchPlayer(team: Team, side: Side, index: number): PitchPlayer {
  const cfg = team.players[index];
  const home = homeFor(side, cfg.role);
  return {
    id: `${side}_${cfg.role}`,
    teamId: team.id,
    side,
    isGK: cfg.role === 'GK',
    name: cfg.name,
    number: cfg.number,
    role: cfg.role,
    appearance: cfg.appearance,
    x: home.x, y: home.y, z: 0,
    vx: 0, vy: 0, vz: 0,
    facingAngle: side === 'USER' ? 0 : Math.PI,
    actionState: 'idle',
    animFrame: 0,
    actionTimer: 0,
    tackleCd: 0,
    decisionCd: 0,
    holdTimer: 0,
    stamina: 100,
    speedRating: cfg.speed,
    shootRating: cfg.shooting,
    passRating: cfg.passing,
    homeX: home.x, homeY: home.y,
    yellowCards: 0,
    sentOff: false,
  };
}

export function createWorld(
  userTeam: Team, cpuTeam: Team, difficulty: Difficulty,
  autoSwitch: boolean, passMode: PassMode, strictness: Strictness
): World {
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const refIndex = Math.floor(rand() * REF_FIRST.length);

  const world: World = {
    userTeam, cpuTeam,
    players: [
      ...userTeam.players.map((_, i) => makePitchPlayer(userTeam, 'USER', i)),
      ...cpuTeam.players.map((_, i) => makePitchPlayer(cpuTeam, 'CPU', i)),
    ],
    referee: {
      x: 0, y: -110, vx: 0, vy: 0, facingAngle: 0, animFrame: 0,
      cardType: null, cardTimer: 0, whistleTimer: 0,
      name: `${REF_FIRST[refIndex]} ${REF_LAST[refIndex]}`,
      assistants: ['Assistant 1 · K. Haruna', 'Assistant 2 · J. Moreau'],
    },
    ball: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, rotationX: 0, rotationY: 0, ownerId: null, passTo: null, passTimer: 0 },
    score: { user: 0, cpu: 0 },
    stats: {
      possession: [0, 0], shots: [0, 0], onTarget: [0, 0], passes: [0, 0],
      tackles: [0, 0], saves: [0, 0], corners: [0, 0], fouls: [0, 0], yellows: [0, 0], reds: [0, 0],
    },
    controlledId: 'USER_FWD',
    passTargetId: null,
    incomingReceiver: null,
    diff: DIFFICULTY[difficulty],
    restart: null,
    gkHold: null,
    gkRelease: null,
    live: false,
    awaitingKickoff: 'USER',
    freeze: 0,
    lastTouch: null,
    autoSwitch,
    passMode,
    strictness,
    events: [],
    pickupCd: 0,
    passCd: 0,
    tick: 0,
    rand,
  };

  setupKickoff(world, 'USER');
  return world;
}

/** Places every player in a legal kick-off shape. The non-kicking team stays in its own half. */
export function setupKickoff(w: World, side: Side) {
  w.players.forEach((p) => {
    if (p.sentOff) return;
    const home = homeFor(p.side, p.role);
    p.x = home.x; p.y = home.y; p.z = 0;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.actionState = 'idle';
    p.actionTimer = 0; p.tackleCd = 0; p.decisionCd = 0; p.holdTimer = 0;
    p.facingAngle = p.side === 'USER' ? 0 : Math.PI;
  });

  const taker = active(w).find((p) => p.side === side && p.role === 'FWD')
    || active(w).find((p) => p.side === side && !p.isGK);

  if (taker) {
    taker.x = side === 'USER' ? -16 : 16;
    taker.y = 0;
  }

  // The defending team must be outside the centre circle and in its own half.
  active(w).forEach((p) => {
    if (p.side === side || p.isGK) return;
    const dir = dirOf(p.side);
    if (p.x * dir > -10) p.x = -40 * dir;
    if (dist(p.x, p.y, 0, 0) < PITCH.circle + 24) p.x = -(PITCH.circle + 60) * dir;
  });

  w.ball = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, rotationX: 0, rotationY: 0,
    ownerId: taker ? taker.id : null, passTo: null, passTimer: 0,
  };
  if (taker) taker.holdTimer = 26;

  w.restart = null;
  w.gkHold = null;
  w.gkRelease = null;
  w.pickupCd = 0;
  w.passCd = 0;
  w.incomingReceiver = null;
  w.freeze = 0;
  w.lastTouch = taker ? { side, name: taker.name } : null;
  w.referee.x = 0; w.referee.y = -130; w.referee.vx = 0; w.referee.vy = 0;

  const userOutfield = active(w).find((p) => p.side === 'USER' && p.role === 'FWD')
    || active(w).find((p) => p.side === 'USER' && !p.isGK);
  if (side === 'USER' && taker) w.controlledId = taker.id;
  else if (userOutfield) w.controlledId = userOutfield.id;
}

/** Called by the UI when the player presses Kick Off after a goal or at the start of a half. */
export function kickOff(w: World, side?: Side) {
  setupKickoff(w, side ?? w.awaitingKickoff ?? 'USER');
  w.awaitingKickoff = null;
  w.live = true;
  w.referee.whistleTimer = 30;
}

/* ================================================================== */
/* PASSING                                                             */
/* ================================================================== */
function profileFor(w: World, p: PitchPlayer) {
  return p.side === 'CPU' ? w.diff : ALLY;
}

function setTouch(w: World, p: PitchPlayer) {
  w.lastTouch = { side: p.side, name: p.name };
}

function laneBlocked(w: World, from: PitchPlayer, tx: number, ty: number): number {
  const dx = tx - from.x;
  const dy = ty - from.y;
  const lenSq = dx * dx + dy * dy || 1;
  let penalty = 0;
  active(w).forEach((opp) => {
    if (opp.side === from.side) return;
    const t = clamp(((opp.x - from.x) * dx + (opp.y - from.y) * dy) / lenSq, 0, 1);
    const lx = from.x + dx * t;
    const ly = from.y + dy * t;
    const gap = Math.hypot(opp.x - lx, opp.y - ly);
    if (t > 0.08 && t < 0.96 && gap < 34) penalty += 170 * (1 - gap / 34);
  });
  return penalty;
}

/**
 * Chooses the teammate a pass should go to.
 * Outfield players are strongly preferred; the keeper is only chosen as a last resort.
 */
export function bestPassTarget(w: World, passer: PitchPlayer, coneOnly = false): PitchPlayer | null {
  const dir = dirOf(passer.side);
  const mates = active(w).filter((p) => p.side === passer.side && p.id !== passer.id);
  let best: PitchPlayer | null = null;
  let bestScore = -Infinity;

  mates.forEach((mate) => {
    const dx = mate.x - passer.x;
    const dy = mate.y - passer.y;
    const d = Math.hypot(dx, dy);
    if (d < 28 || d > 620) return;

    if (coneOnly) {
      const diff = Math.abs(norm(Math.atan2(dy, dx) - passer.facingAngle));
      if (diff > 0.95) return;
    }

    let score = 240 - Math.abs(d - 190) * 0.42;
    score += (dx * dir) * 0.42;
    score += (mate.x * dir) * 0.16;
    score -= laneBlocked(w, passer, mate.x, mate.y);

    // Space around the receiver.
    const nearest = active(w)
      .filter((o) => o.side !== passer.side)
      .reduce((min, o) => Math.min(min, dist(o.x, o.y, mate.x, mate.y)), 999);
    score += Math.min(nearest, 120) * 0.7;

    if (mate.isGK) score -= 420;
    if (coneOnly) {
      const diff = Math.abs(norm(Math.atan2(dy, dx) - passer.facingAngle));
      score += (1 - diff) * 180;
    }

    if (score > bestScore) { bestScore = score; best = mate; }
  });

  return best;
}

/**
 * A goalkeeper puts the ball back into play.
 * This always succeeds while the match is live, so possession can never stall
 * with the keeper, and he can never immediately re-gather his own distribution.
 */
export function releaseFromKeeper(w: World, keeper: PitchPlayer): boolean {
  if (!w.live || !keeper || keeper.sentOff) return false;
  if (w.ball.ownerId !== keeper.id) return false;

  const dir = dirOf(keeper.side);
  const target = bestPassTarget(w, keeper);

  // Face the receiver, or upfield, so a fallback clearance never goes into our own net.
  keeper.facingAngle = target
    ? Math.atan2(target.y - keeper.y, target.x - keeper.x)
    : (dir === 1 ? 0 : Math.PI);

  // A cooldown must never trap the ball in the keeper's hands.
  w.passCd = 0;
  keeper.holdTimer = 0;

  const released = doPass(w, keeper);
  if (!released) return false;

  w.gkHold = null;
  w.gkRelease = { id: keeper.id, timer: 75 };
  w.pickupCd = Math.max(w.pickupCd, 12);

  // Hand control to the player receiving the keeper's distribution.
  if (keeper.side === 'USER' && w.autoSwitch && w.incomingReceiver) {
    const receiver = getById(w, w.incomingReceiver);
    if (receiver && !receiver.isGK) w.controlledId = receiver.id;
  }
  return true;
}

export function doPass(w: World, passerArg?: PitchPlayer | null): boolean {
  if (!w.live) return false;

  // Pressing Pass while our own keeper holds the ball makes him distribute immediately.
  if (!passerArg) {
    const holder = getById(w, w.ball.ownerId);
    if (holder && holder.isGK && holder.side === 'USER') {
      return releaseFromKeeper(w, holder);
    }
  }

  if (w.passCd > 0) return false;
  const passer = passerArg || getById(w, w.controlledId);
  if (!passer || passer.sentOff) return false;

  const b = w.ball;
  const owns = b.ownerId === passer.id;
  if (!owns && dist(passer.x, passer.y, b.x, b.y) > 34) return false;

  const manual = w.passMode === 'MANUAL' && passer.id === w.controlledId;
  const target = bestPassTarget(w, passer, manual);
  const prof = profileFor(w, passer);
  const userPass = passer.id === w.controlledId;
  const accuracy = userPass
    ? (manual ? 0.86 : 0.97)
    : prof.passAcc * (0.9 + passer.passRating / 900);

  let tx: number;
  let ty: number;

  if (target) {
    // Lead the pass in front of a moving receiver.
    const lead = Math.min(26, dist(passer.x, passer.y, target.x, target.y) * 0.08);
    tx = target.x + target.vx * lead;
    ty = target.y + target.vy * lead;
  } else {
    tx = passer.x + Math.cos(passer.facingAngle) * 180;
    ty = passer.y + Math.sin(passer.facingAngle) * 180;
  }

  // Never deliberately pass the ball off the pitch.
  tx = clamp(tx, -PITCH.halfW + 24, PITCH.halfW - 24);
  ty = clamp(ty, -PITCH.halfH + 24, PITCH.halfH - 24);

  let angle = Math.atan2(ty - b.y, tx - b.x);
  angle += (1 - accuracy) * 0.3 * (w.rand() * 2 - 1);

  const d = Math.hypot(tx - b.x, ty - b.y);
  const speed = clamp(6.2 + d * 0.028, 7.2, 15.5);

  b.ownerId = null;
  b.vx = Math.cos(angle) * speed;
  b.vy = Math.sin(angle) * speed;
  b.vz = 0.9;
  b.spin = 0;
  b.passTo = target && !manual ? target.id : null;
  b.passTimer = 150;

  w.pickupCd = 8;
  w.passCd = 12;
  w.incomingReceiver = target ? target.id : null;

  passer.actionState = 'pass';
  passer.actionTimer = 15;
  passer.facingAngle = angle;
  setTouch(w, passer);
  w.stats.passes[sideIndex(passer.side)]++;
  w.events.push({ type: 'PASS', side: passer.side });

  if (passer.side === 'USER' && userPass && target && !target.isGK && w.autoSwitch) {
    w.controlledId = target.id;
  }
  return true;
}

export function doShoot(w: World, shooterArg?: PitchPlayer | null): boolean {
  if (!w.live) return false;
  const shooter = shooterArg || getById(w, w.controlledId);
  if (!shooter || shooter.sentOff) return false;
  const b = w.ball;
  if (b.ownerId !== shooter.id && dist(shooter.x, shooter.y, b.x, b.y) > 38) return false;

  const prof = profileFor(w, shooter);
  const userShot = shooter.id === w.controlledId;
  const dir = dirOf(shooter.side);
  const goalX = PITCH.halfW * dir;

  const keeper = active(w).find((p) => p.isGK && p.side !== shooter.side);
  const corner = keeper ? (keeper.y >= 0 ? -1 : 1) : (shooter.y >= 0 ? -1 : 1);
  const aimY = corner * (PITCH.goalHalf - 26);

  const accuracy = userShot ? 0.88 + shooter.shootRating / 1800 : prof.shotAcc * (0.85 + shooter.shootRating / 900);
  let angle = Math.atan2(aimY - b.y, goalX - b.x);
  angle += (1 - accuracy) * 0.3 * (w.rand() * 2 - 1);

  const d = Math.hypot(goalX - b.x, aimY - b.y);
  const power = clamp(13.5 + d * 0.011, 14, 18.5);

  b.ownerId = null;
  b.passTo = null;
  b.vx = Math.cos(angle) * power;
  b.vy = Math.sin(angle) * power;
  b.vz = 2 + w.rand() * 1.7;
  b.spin = (w.rand() - 0.5) * 0.09;
  w.pickupCd = 10;
  w.incomingReceiver = null;

  shooter.actionState = 'shoot';
  shooter.actionTimer = 21;
  shooter.facingAngle = angle;
  setTouch(w, shooter);

  const idx = sideIndex(shooter.side);
  w.stats.shots[idx]++;
  const travel = (goalX - b.x) / (b.vx || dir * 0.01);
  if (travel > 0 && Math.abs(b.y + b.vy * travel) < PITCH.goalHalf) w.stats.onTarget[idx]++;

  w.events.push({ type: 'SHOT', side: shooter.side });
  return true;
}

/* ================================================================== */
/* REFEREE, FOULS AND CARDS                                            */
/* ================================================================== */
function showCard(w: World, offender: PitchPlayer, type: 'YELLOW' | 'RED'): 'YELLOW' | 'RED' {
  const ref = w.referee;
  let final: 'YELLOW' | 'RED' = type;

  if (type === 'YELLOW') {
    offender.yellowCards++;
    w.stats.yellows[sideIndex(offender.side)]++;
    if (offender.yellowCards >= 2) final = 'RED';
  }

  if (final === 'RED') {
    offender.sentOff = true;
    offender.vx = 0; offender.vy = 0;
    offender.x = -PITCH.halfW - 60;
    offender.y = PITCH.halfH + 60;
    w.stats.reds[sideIndex(offender.side)]++;
    if (w.controlledId === offender.id) switchPlayer(w);
  }

  ref.cardType = final;
  ref.cardTimer = 110;
  return final;
}

function awardFoul(w: World, offender: PitchPlayer, victim: PitchPlayer) {
  const dir = dirOf(offender.side);
  const ownGoalX = -PITCH.halfW * dir;
  w.stats.fouls[sideIndex(offender.side)]++;

  // Inside the offending team's own penalty area -> penalty kick.
  const insideOwnBox =
    Math.abs(victim.x - ownGoalX) < PITCH.boxW && Math.abs(victim.y) < PITCH.boxH / 2;

  const reckless = Math.hypot(offender.vx, offender.vy) > 4.6;
  const cardRoll = w.rand();
  const cardChance = STRICT_CARD[w.strictness] * (reckless ? 1.6 : 0.7) * (insideOwnBox ? 1.3 : 1);

  let card: 'YELLOW' | 'RED' | null = null;
  if (cardRoll < cardChance * 0.08) card = showCard(w, offender, 'RED');
  else if (cardRoll < cardChance) card = showCard(w, offender, 'YELLOW');

  w.referee.whistleTimer = 26;
  w.ball.passTo = null;
  w.incomingReceiver = null;

  const teamName = offender.side === 'USER' ? w.userTeam.shortName : w.cpuTeam.shortName;

  if (insideOwnBox) {
    beginRestart(w, 'PENALTY', victim.side, ownGoalX + PITCH.penaltySpot * dir, 0);
    w.events.push({
      type: 'DECISION',
      text: `Penalty! Foul by ${teamName} · ${offender.name}`,
      card,
    });
  } else {
    beginRestart(w, 'FREEKICK', victim.side,
      clamp(victim.x, -PITCH.halfW + 30, PITCH.halfW - 30),
      clamp(victim.y, -PITCH.halfH + 24, PITCH.halfH - 24));
    w.events.push({
      type: 'DECISION',
      text: `Free kick · foul by ${teamName} ${offender.name}${card ? ` (${card.toLowerCase()} card)` : ''}`,
      card,
    });
  }
}

export function doTackle(w: World, playerArg?: PitchPlayer | null): boolean {
  if (!w.live) return false;
  const p = playerArg || getById(w, w.controlledId);
  if (!p || p.sentOff || p.tackleCd > 0 || w.restart) return false;
  const b = w.ball;

  p.actionState = 'tackle';
  p.actionTimer = 17;
  p.tackleCd = 40;
  p.vx = Math.cos(p.facingAngle) * 5.6;
  p.vy = Math.sin(p.facingAngle) * 5.6;

  const owner = getById(w, b.ownerId);

  // The keeper holding the ball may not be challenged.
  if (owner && owner.isGK && owner.side !== p.side) return false;

  const ballDist = dist(p.x, p.y, b.x, b.y);
  const prof = profileFor(w, p);

  if (ballDist < 34 && (!owner || owner.side !== p.side)) {
    const chance = p.id === w.controlledId ? 0.78 : 0.3 + prof.tackle * 0.55;
    if (w.rand() < chance) {
      b.ownerId = p.id;
      b.vx = 0; b.vy = 0; b.passTo = null;
      p.holdTimer = 22;
      setTouch(w, p);
      w.stats.tackles[sideIndex(p.side)]++;
      w.events.push({ type: 'TACKLE', side: p.side });
      if (p.side === 'USER' && !p.isGK && w.autoSwitch) w.controlledId = p.id;
      return true;
    }
  }

  // Missed the ball but caught the opponent -> foul.
  if (owner && owner.side !== p.side && dist(p.x, p.y, owner.x, owner.y) < 30) {
    if (w.rand() < STRICT_FOUL[w.strictness]) {
      awardFoul(w, p, owner);
      return false;
    }
  }
  return false;
}

export function switchPlayer(w: World) {
  const outfield = active(w).filter((p) => p.side === 'USER' && !p.isGK);
  if (!outfield.length) return;
  const sorted = [...outfield].sort(
    (a, b) => dist(a.x, a.y, w.ball.x, w.ball.y) - dist(b.x, b.y, w.ball.x, w.ball.y)
  );
  const current = sorted.findIndex((p) => p.id === w.controlledId);
  w.controlledId = sorted[(current + 1) % sorted.length].id;
}

function updateReferee(w: World) {
  const ref = w.referee;
  const b = w.ball;
  if (ref.cardTimer > 0) ref.cardTimer--;
  else ref.cardType = null;
  if (ref.whistleTimer > 0) ref.whistleTimer--;

  // Stay near play but always a comfortable distance from the ball.
  const away = Math.atan2(ref.y - b.y, ref.x - b.x);
  const standoff = 86;
  let tx = b.x + Math.cos(away) * standoff;
  let ty = b.y + Math.sin(away) * standoff;

  // Prefer a diagonal position slightly behind play and never inside the goal areas.
  ty = clamp(ty, -PITCH.halfH + 26, PITCH.halfH - 26);
  tx = clamp(tx, -PITCH.halfW + 40, PITCH.halfW - 40);

  const dx = tx - ref.x;
  const dy = ty - ref.y;
  const d = Math.hypot(dx, dy);
  if (d > 6) {
    const speed = Math.min(3.1, 0.9 + d * 0.05);
    ref.vx += ((dx / d) * speed - ref.vx) * 0.12;
    ref.vy += ((dy / d) * speed - ref.vy) * 0.12;
  } else {
    ref.vx *= 0.8; ref.vy *= 0.8;
  }

  ref.x += ref.vx;
  ref.y += ref.vy;

  // Never interfere with the ball or players.
  const ballGap = dist(ref.x, ref.y, b.x, b.y);
  if (ballGap < 34 && ballGap > 0.01) {
    ref.x = b.x + ((ref.x - b.x) / ballGap) * 34;
    ref.y = b.y + ((ref.y - b.y) / ballGap) * 34;
  }
  active(w).forEach((p) => {
    const gap = dist(ref.x, ref.y, p.x, p.y);
    if (gap < 24 && gap > 0.01) {
      ref.x = p.x + ((ref.x - p.x) / gap) * 24;
      ref.y = p.y + ((ref.y - p.y) / gap) * 24;
    }
  });

  ref.x = clamp(ref.x, -PITCH.halfW + 14, PITCH.halfW - 14);
  ref.y = clamp(ref.y, -PITCH.halfH + 14, PITCH.halfH - 14);

  const speed = Math.hypot(ref.vx, ref.vy);
  if (speed > 0.25) {
    ref.animFrame += speed * 0.085;
    ref.facingAngle = Math.atan2(ref.vy, ref.vx);
  }
}

/* ================================================================== */
/* RESTARTS                                                            */
/* ================================================================== */
function beginRestart(w: World, type: RestartKind, side: Side, x: number, y: number) {
  w.restart = { type, side, x, y, timer: type === 'PENALTY' ? 95 : 60 };
  const b = w.ball;
  b.ownerId = null; b.passTo = null;
  b.vx = 0; b.vy = 0; b.vz = 0; b.z = 0;
  b.x = x; b.y = y;
  w.incomingReceiver = null;
  if (type === 'CORNER') w.stats.corners[sideIndex(side)]++;
  w.events.push({ type: 'RESTART', kind: type, side });
}

function handleRestart(w: World) {
  const r = w.restart;
  if (!r) return;
  const b = w.ball;
  b.x = r.x; b.y = r.y; b.z = 0; b.vx = 0; b.vy = 0; b.vz = 0; b.ownerId = null;

  const dir = dirOf(r.side);

  if (r.type === 'PENALTY') {
    // Everyone except the taker and the defending keeper clears the box.
    active(w).forEach((p) => {
      if (p.isGK) {
        if (p.side !== r.side) {
          p.x = PITCH.halfW * dir - 6 * dir;
          p.y = clamp(p.y, -PITCH.goalHalf + 10, PITCH.goalHalf - 10);
        }
        return;
      }
      const isTaker = p.side === r.side && p.role === 'FWD';
      if (isTaker) { p.x = r.x - 26 * dir; p.y = 0; return; }
      const behind = r.x - 110 * dir;
      p.x += (behind - p.x) * 0.12;
      p.y += ((p.y >= 0 ? 150 : -150) - p.y) * 0.1;
    });
  } else {
    // Opponents retreat the required distance from the restart.
    const required = r.type === 'FREEKICK' ? 110 : 92;
    active(w).forEach((p) => {
      if (p.side === r.side) return;
      const d = dist(p.x, p.y, r.x, r.y);
      if (d < required && d > 0.01) {
        p.x += ((p.x - r.x) / d) * 3.6;
        p.y += ((p.y - r.y) / d) * 3.6;
      }
    });
  }

  r.timer--;
  if (r.timer > 0) return;

  const pool = active(w).filter((p) => {
    if (r.type === 'GOALKICK') return p.side === r.side && p.isGK;
    if (r.type === 'PENALTY') return p.side === r.side && p.role === 'FWD';
    return p.side === r.side && !p.isGK;
  });
  const taker = pool.sort((a, b2) => dist(a.x, a.y, r.x, r.y) - dist(b2.x, b2.y, r.x, r.y))[0]
    || active(w).find((p) => p.side === r.side);

  if (taker) {
    taker.x = r.x - 20 * dir;
    taker.y = r.y;
    taker.facingAngle = dir === 1 ? 0 : Math.PI;
    b.ownerId = taker.id;
    taker.holdTimer = 30;
    setTouch(w, taker);
    if (taker.side === 'USER' && !taker.isGK) w.controlledId = taker.id;
  }

  w.restart = null;
  w.pickupCd = 6;
}

/* ================================================================== */
/* MOVEMENT                                                            */
/* ================================================================== */
function baseSpeed(p: PitchPlayer, prof: DiffProfile) {
  return (3.15 + (p.speedRating - 75) * 0.011) * prof.speed;
}

function moveTo(p: PitchPlayer, tx: number, ty: number, speed: number) {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 7) {
    p.vx *= 0.72; p.vy *= 0.72;
    if (p.actionTimer <= 0) p.actionState = 'idle';
    return;
  }
  const want = Math.min(speed, 1.1 + d * 0.11);
  p.vx += ((dx / d) * want - p.vx) * 0.23;
  p.vy += ((dy / d) * want - p.vy) * 0.23;
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > 0.3) p.facingAngle = Math.atan2(p.vy, p.vx);
  if (p.actionTimer <= 0) p.actionState = sp > 3.7 ? 'sprint' : sp > 1.5 ? 'run' : 'walk';
}

function separation(w: World, p: PitchPlayer) {
  let sx = 0; let sy = 0;
  active(w).forEach((o) => {
    if (o.id === p.id || o.side !== p.side) return;
    const d = dist(p.x, p.y, o.x, o.y);
    if (d < 62 && d > 0.01) { sx += (p.x - o.x) / d; sy += (p.y - o.y) / d; }
  });
  return { sx: sx * 46, sy: sy * 46 };
}

/* ================================================================== */
/* AI                                                                  */
/* ================================================================== */
interface AiContext {
  owner: PitchPlayer | null;
  possSide: Side | null;
  ranks: Record<Side, string[]>;
}

/** Shape used while a goalkeeper is holding the ball: both teams reset into their own halves. */
function goalkeeperHoldShape(p: PitchPlayer, holdingSide: Side) {
  const dir = dirOf(p.side);
  let tx: number;
  let ty: number;

  if (p.side === holdingSide) {
    // Spread out to offer a distribution option, still inside the own half.
    tx = p.homeX + dir * 72;
    ty = p.homeY * 1.3;
  } else {
    // Drop back into the own half and get organised.
    tx = p.homeX - dir * 48;
    ty = p.homeY * 0.85;
  }

  tx = clamp(tx, -PITCH.halfW + 50, PITCH.halfW - 50);
  ty = clamp(ty, -PITCH.halfH + 40, PITCH.halfH - 40);
  moveTo(p, tx, ty, 2.9);
}

function keeperAI(w: World, p: PitchPlayer) {
  const prof = profileFor(w, p);
  const dir = dirOf(p.side);
  const goalX = -PITCH.halfW * dir;
  const b = w.ball;

  if (b.ownerId === p.id) {
    moveTo(p, goalX + 52 * dir, clamp(b.y * 0.25, -55, 55), 2.1);
    p.actionState = p.actionTimer > 0 ? p.actionState : 'idle';
    // Once the reset window is over the keeper releases the ball. This retries
    // every frame, so possession can never get stuck with the goalkeeper.
    if (!w.gkHold && p.holdTimer <= 0) releaseFromKeeper(w, p);
    return;
  }

  const threatening = Math.abs(b.x - goalX) < 330;
  const targetX = goalX + (threatening ? 30 : 16) * dir;
  let targetY = clamp(b.y * 0.6, -PITCH.goalHalf + 8, PITCH.goalHalf - 8);

  const incoming = !b.ownerId && (dir === 1 ? b.vx < -5 : b.vx > 5) && Math.abs(b.x - goalX) < 430;
  if (incoming) {
    const t = (goalX - b.x) / b.vx;
    if (t > 0 && t < 90) {
      const error = (1 - prof.keeper) * 62 * (w.rand() * 2 - 1);
      targetY = clamp(b.y + b.vy * t + error, -PITCH.goalHalf - 14, PITCH.goalHalf + 14);
      if (Math.abs(targetY - p.y) > 20 && p.actionTimer <= 0) {
        p.actionState = 'dive_save';
        p.actionTimer = 16;
      }
    }
  }

  moveTo(p, targetX, targetY, 1.9 + prof.keeper * 1.9);
  p.x = clamp(p.x, Math.min(goalX, goalX + PITCH.boxW * dir) + 6, Math.max(goalX, goalX + PITCH.boxW * dir) - 6);
  p.y = clamp(p.y, -PITCH.boxH / 2 + 10, PITCH.boxH / 2 - 10);
}

function carrierAI(w: World, p: PitchPlayer) {
  const prof = profileFor(w, p);
  const dir = dirOf(p.side);
  const goalX = PITCH.halfW * dir;
  const toGoal = Math.hypot(goalX - p.x, p.y * 0.8);
  const pressure = active(w).filter((o) => o.side !== p.side && !o.isGK && dist(o.x, o.y, p.x, p.y) < 85).length;

  if (p.decisionCd > 0) p.decisionCd--;

  if (p.decisionCd <= 0 && p.holdTimer <= 0) {
    const goodAngle = Math.abs(p.y) < 215;
    if (toGoal < 310 && goodAngle && (toGoal < 165 || pressure === 0 || w.rand() < 0.35 * prof.aggro)) {
      doShoot(w, p);
      p.decisionCd = 75;
      return;
    }
    if (pressure > 0 && w.rand() < 0.5 * prof.aggro) {
      if (doPass(w, p)) { p.decisionCd = 42; return; }
    }
    if (w.rand() < 0.015) {
      if (doPass(w, p)) { p.decisionCd = 48; return; }
    }
  }

  let targetY = clamp(p.y * 0.55, -170, 170);
  const nearest = active(w)
    .filter((o) => o.side !== p.side && !o.isGK)
    .sort((a, b2) => dist(a.x, a.y, p.x, p.y) - dist(b2.x, b2.y, p.x, p.y))[0];
  if (nearest && dist(nearest.x, nearest.y, p.x, p.y) < 110) {
    targetY = clamp(p.y + (p.y >= nearest.y ? 95 : -95), -PITCH.halfH + 50, PITCH.halfH - 50);
  }

  moveTo(p, p.x + dir * 150, targetY, baseSpeed(p, prof) * 0.97);
  if (p.actionTimer <= 0) p.actionState = 'dribble';
}

/** A player expecting a pass runs onto the ball. */
function receiveAI(w: World, p: PitchPlayer) {
  const prof = profileFor(w, p);
  const b = w.ball;
  const t = clamp(dist(p.x, p.y, b.x, b.y) / 14, 2, 16);
  const tx = clamp(b.x + b.vx * t * 0.5, -PITCH.halfW + 20, PITCH.halfW - 20);
  const ty = clamp(b.y + b.vy * t * 0.5, -PITCH.halfH + 20, PITCH.halfH - 20);
  moveTo(p, tx, ty, baseSpeed(p, prof) * 1.08);
  if (dist(p.x, p.y, b.x, b.y) < 46 && p.actionTimer <= 0) {
    p.actionState = 'receive';
  }
}

function attackOffBall(w: World, p: PitchPlayer, ctx: AiContext) {
  const prof = profileFor(w, p);
  const dir = dirOf(p.side);
  const carrier = ctx.owner;
  const mates = active(w).filter((o) => o.side === p.side && !o.isGK && o.id !== (carrier ? carrier.id : ''));
  const isRunner = mates.length < 2 || (mates[0].x * dir >= mates[1].x * dir ? mates[0].id === p.id : mates[1].id === p.id);
  const ref = carrier || w.ball;

  let tx: number;
  let ty: number;
  if (isRunner) {
    tx = clamp(ref.x + dir * 185, -PITCH.halfW + 70, PITCH.halfW - 55);
    ty = (carrier && carrier.y >= 0 ? -1 : 1) * 120;
  } else {
    tx = clamp(ref.x - dir * 55, -PITCH.halfW + 70, PITCH.halfW - 120);
    ty = (carrier && carrier.y >= 0 ? 1 : -1) * 115;
  }

  if (carrier && dist(tx, ty, carrier.x, carrier.y) < 85) ty += ty >= 0 ? 80 : -80;
  const sep = separation(w, p);
  moveTo(p, tx + sep.sx, ty + sep.sy, baseSpeed(p, prof) * 0.95);
}

function defendAI(w: World, p: PitchPlayer, ctx: AiContext, rank: number) {
  const prof = profileFor(w, p);
  const dir = dirOf(p.side);
  const ownGoalX = -PITCH.halfW * dir;
  const b = w.ball;
  const sep = separation(w, p);

  if (rank === 0) {
    const lead = ctx.owner ? 10 : 6;
    moveTo(p, b.x + b.vx * lead * 0.5, b.y + b.vy * lead * 0.5, baseSpeed(p, prof));
    const d = dist(p.x, p.y, b.x, b.y);
    const ownerIsKeeper = ctx.owner ? ctx.owner.isGK : false;
    if (d < 34 && p.tackleCd <= 0 && !ownerIsKeeper && ctx.possSide && ctx.possSide !== p.side
      && w.rand() < 0.03 * prof.react) {
      doTackle(w, p);
    }
    return;
  }

  const threats = active(w)
    .filter((o) => o.side !== p.side && !o.isGK && o.id !== (ctx.owner ? ctx.owner.id : ''))
    .sort((a, b2) => (a.x - b2.x) * -dir);
  const mark = threats[0];

  let tx: number;
  let ty: number;
  if (mark) { tx = mark.x - dir * 42; ty = mark.y * 0.85; }
  else { tx = (b.x + ownGoalX) / 2; ty = b.y * 0.5; }

  tx = dir === 1 ? Math.min(tx, b.x - 20) : Math.max(tx, b.x + 20);
  moveTo(p, tx + sep.sx, ty + sep.sy, baseSpeed(p, prof) * 0.94);
}

function updateAI(w: World) {
  const owner = getById(w, w.ball.ownerId);
  const list = active(w);
  const ctx: AiContext = {
    owner,
    possSide: owner ? owner.side : null,
    ranks: {
      USER: list.filter((p) => p.side === 'USER' && !p.isGK)
        .sort((a, b) => dist(a.x, a.y, w.ball.x, w.ball.y) - dist(b.x, b.y, w.ball.x, w.ball.y)).map((p) => p.id),
      CPU: list.filter((p) => p.side === 'CPU' && !p.isGK)
        .sort((a, b) => dist(a.x, a.y, w.ball.x, w.ball.y) - dist(b.x, b.y, w.ball.x, w.ball.y)).map((p) => p.id),
    },
  };

  list.forEach((p) => {
    if (p.actionTimer > 0) p.actionTimer--;
    if (p.tackleCd > 0) p.tackleCd--;
    if (p.holdTimer > 0) p.holdTimer--;
    if (p.id === w.controlledId) return;

    // Goalkeeper has possession: both teams reorganise.
    if (w.gkHold && !p.isGK) { goalkeeperHoldShape(p, w.gkHold.side); return; }

    if (p.isGK) { keeperAI(w, p); return; }
    if (w.ball.ownerId === p.id) { carrierAI(w, p); return; }
    if (w.incomingReceiver === p.id && !w.ball.ownerId) { receiveAI(w, p); return; }

    const rank = ctx.ranks[p.side].indexOf(p.id);
    if (ctx.possSide === p.side) attackOffBall(w, p, ctx);
    else if (ctx.possSide === null && rank === 0) {
      moveTo(p, w.ball.x + w.ball.vx * 6, w.ball.y + w.ball.vy * 6, baseSpeed(p, profileFor(w, p)));
    } else defendAI(w, p, ctx, rank);
  });
}

function updateControlled(w: World, input: InputState) {
  const p = getById(w, w.controlledId);
  if (!p || p.sentOff) { switchPlayer(w); return; }

  let mx = 0; let my = 0;
  if (input.up) my -= 1;
  if (input.down) my += 1;
  if (input.left) mx -= 1;
  if (input.right) mx += 1;

  const top = input.sprint ? 4.5 : 3.45;

  if (mx !== 0 || my !== 0) {
    const len = Math.hypot(mx, my);
    p.vx += ((mx / len) * top - p.vx) * 0.3;
    p.vy += ((my / len) * top - p.vy) * 0.3;
    p.facingAngle = Math.atan2(my, mx);
    if (p.actionTimer <= 0) p.actionState = input.sprint ? 'sprint' : w.ball.ownerId === p.id ? 'dribble' : 'run';
  } else if (input.pointer && input.pointer.active) {
    const dx = input.pointer.x - p.x;
    const dy = input.pointer.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 16) {
      p.vx += ((dx / d) * top - p.vx) * 0.3;
      p.vy += ((dy / d) * top - p.vy) * 0.3;
      p.facingAngle = Math.atan2(dy, dx);
      if (p.actionTimer <= 0) p.actionState = w.ball.ownerId === p.id ? 'dribble' : 'run';
    } else {
      p.vx *= 0.7; p.vy *= 0.7;
      if (p.actionTimer <= 0) p.actionState = 'idle';
    }
  } else {
    p.vx *= 0.74; p.vy *= 0.74;
    if (p.actionTimer <= 0 && Math.hypot(p.vx, p.vy) < 0.4) p.actionState = 'idle';
  }
}

/* ================================================================== */
/* PHYSICS                                                             */
/* ================================================================== */
function integratePlayers(w: World) {
  const list = active(w);
  list.forEach((p) => {
    p.x += p.vx;
    p.y += p.vy;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 0.25) p.animFrame += speed * 0.085;
    p.x = clamp(p.x, -PITCH.halfW + 12, PITCH.halfW - 12);
    p.y = clamp(p.y, -PITCH.halfH + 12, PITCH.halfH - 12);
  });

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const d = dist(a.x, a.y, b.x, b.y);
      if (d < 23 && d > 0.01) {
        const push = (23 - d) / 2;
        const nx = (a.x - b.x) / d;
        const ny = (a.y - b.y) / d;
        a.x += nx * push; a.y += ny * push;
        b.x -= nx * push; b.y -= ny * push;
      }
    }
  }
}

function scoreGoal(w: World, side: Side) {
  const touch = w.lastTouch;
  const ownGoal = !!touch && touch.side !== side;
  const scorer = touch ? touch.name : 'Unknown';

  if (side === 'USER') w.score.user++; else w.score.cpu++;

  const b = w.ball;
  b.vx = 0; b.vy = 0; b.vz = 0; b.ownerId = null; b.passTo = null;

  // Play stops completely until the UI calls kickOff().
  w.live = false;
  w.awaitingKickoff = side === 'USER' ? 'CPU' : 'USER';
  w.restart = null;
  w.gkHold = null;
  w.gkRelease = null;
  w.incomingReceiver = null;
  w.referee.whistleTimer = 30;
  w.events.push({ type: 'GOAL', side, scorer, ownGoal });
}

function handleBounds(w: World): boolean {
  const b = w.ball;
  const insidePosts = Math.abs(b.y) <= PITCH.goalHalf - BALL_R * 0.6;
  const underBar = b.z + BALL_R <= PITCH.crossbar;

  if (insidePosts && underBar) {
    if (b.x - BALL_R >= PITCH.halfW) { scoreGoal(w, 'USER'); return true; }
    if (b.x + BALL_R <= -PITCH.halfW) { scoreGoal(w, 'CPU'); return true; }
  }

  if (Math.abs(b.y) > PITCH.halfH + BALL_R) {
    const side: Side = w.lastTouch && w.lastTouch.side === 'USER' ? 'CPU' : 'USER';
    beginRestart(w, 'THROW', side, clamp(b.x, -PITCH.halfW + 30, PITCH.halfW - 30), Math.sign(b.y) * (PITCH.halfH - 6));
    return true;
  }

  if (b.x > PITCH.halfW + BALL_R) {
    const lastUser = w.lastTouch ? w.lastTouch.side === 'USER' : true;
    if (lastUser) beginRestart(w, 'GOALKICK', 'CPU', PITCH.halfW - PITCH.sixW - 20, 0);
    else beginRestart(w, 'CORNER', 'USER', PITCH.halfW - 10, Math.sign(b.y || 1) * (PITCH.halfH - 10));
    return true;
  }
  if (b.x < -PITCH.halfW - BALL_R) {
    const lastCpu = w.lastTouch ? w.lastTouch.side === 'CPU' : true;
    if (lastCpu) beginRestart(w, 'GOALKICK', 'USER', -PITCH.halfW + PITCH.sixW + 20, 0);
    else beginRestart(w, 'CORNER', 'CPU', -PITCH.halfW + 10, Math.sign(b.y || 1) * (PITCH.halfH - 10));
    return true;
  }
  return false;
}

function hitFrame(w: World) {
  const b = w.ball;
  const posts: [number, number][] = [
    [PITCH.halfW, PITCH.goalHalf], [PITCH.halfW, -PITCH.goalHalf],
    [-PITCH.halfW, PITCH.goalHalf], [-PITCH.halfW, -PITCH.goalHalf],
  ];
  posts.forEach(([px, py]) => {
    const d = dist(b.x, b.y, px, py);
    const r = BALL_R + 5;
    if (d < r && d > 0.01 && b.z < PITCH.crossbar) {
      const nx = (b.x - px) / d;
      const ny = (b.y - py) / d;
      b.x = px + nx * r;
      b.y = py + ny * r;
      const dot = b.vx * nx + b.vy * ny;
      b.vx = (b.vx - 2 * dot * nx) * 0.7;
      b.vy = (b.vy - 2 * dot * ny) * 0.7;
      b.passTo = null;
      w.events.push({ type: 'POST' });
    }
  });

  [PITCH.halfW, -PITCH.halfW].forEach((lineX) => {
    if (Math.abs(b.x - lineX) < BALL_R + 4 && Math.abs(b.y) < PITCH.goalHalf &&
      b.z + BALL_R > PITCH.crossbar && b.z - BALL_R < PITCH.crossbar + 8) {
      b.vz = -Math.abs(b.vz) * 0.55;
      b.vx *= -0.45;
      b.z = PITCH.crossbar - BALL_R - 1;
      b.passTo = null;
      w.events.push({ type: 'POST' });
    }
  });
}

function beginGkHold(w: World, keeper: PitchPlayer) {
  const b = w.ball;
  b.ownerId = keeper.id;
  b.vx = 0; b.vy = 0; b.vz = 0; b.z = 0; b.passTo = null;
  keeper.holdTimer = 100;
  keeper.actionState = 'dive_save';
  keeper.actionTimer = 22;
  w.gkHold = { side: keeper.side, timer: 100 };
  w.incomingReceiver = null;
  setTouch(w, keeper);
}

function keeperInterception(w: World) {
  const b = w.ball;
  if (b.ownerId || w.gkHold || w.pickupCd > 0) return;
  active(w).forEach((p) => {
    if (!p.isGK) return;
    // A keeper may not re-gather the ball he has just put back into play.
    if (w.gkRelease && w.gkRelease.id === p.id) return;

    const d = dist(p.x, p.y, b.x, b.y);
    if (d > 30 || b.z > 95) return;

    const prof = profileFor(w, p);
    const fast = Math.hypot(b.vx, b.vy) > 9;

    // Back-pass rule: the keeper cannot handle a ball played to him by a teammate.
    // He controls it with his feet and must play on like an outfield player.
    if (!fast && w.lastTouch && w.lastTouch.side === p.side) {
      b.ownerId = p.id;
      b.vx = 0; b.vy = 0; b.vz = 0; b.z = 0; b.passTo = null;
      p.holdTimer = 26;
      p.actionState = 'receive';
      p.actionTimer = 9;
      w.incomingReceiver = null;
      setTouch(w, p);
      return;
    }

    const catches = !fast || w.rand() < 0.25 + prof.keeper * 0.45;

    if (catches) {
      beginGkHold(w, p);
      if (fast) { w.stats.saves[sideIndex(p.side)]++; w.events.push({ type: 'SAVE', side: p.side, caught: true }); }
    } else {
      // Parry: the ball stays live and can be contested.
      const dir = dirOf(p.side);
      b.vx = Math.abs(b.vx) * 0.55 * dir;
      b.vy = (b.vy + (w.rand() - 0.5) * 9) * 0.85;
      b.vz = 1.4;
      b.passTo = null;
      w.pickupCd = 10;
      w.stats.saves[sideIndex(p.side)]++;
      p.actionState = 'dive_save';
      p.actionTimer = 20;
      w.events.push({ type: 'SAVE', side: p.side, caught: false });
    }
  });
}

function updateBall(w: World) {
  const b = w.ball;
  const SUB = 4;

  for (let s = 0; s < SUB; s++) {
    const owner = getById(w, b.ownerId);
    if (owner) {
      const reach = owner.isGK ? 13 : 17;
      const tx = owner.x + Math.cos(owner.facingAngle) * reach;
      const ty = owner.y + Math.sin(owner.facingAngle) * reach;
      b.x += (tx - b.x) * 0.45;
      b.y += (ty - b.y) * 0.45;
      b.z = 0;
      b.vx = owner.vx; b.vy = owner.vy; b.vz = 0;
      b.rotationX += owner.vx * 0.05;
      b.rotationY += owner.vy * 0.05;

      // A keeper in possession cannot be dispossessed.
      if (owner.holdTimer <= 0 && !owner.isGK) {
        for (const op of active(w)) {
          if (op.side === owner.side || op.tackleCd > 0 || op.isGK) continue;
          if (dist(op.x, op.y, b.x, b.y) < 21) {
            const prof = profileFor(w, op);
            if (w.rand() < 0.010 + prof.tackle * 0.028) {
              b.ownerId = op.id;
              op.holdTimer = 22;
              owner.actionState = 'idle';
              setTouch(w, op);
              w.stats.tackles[sideIndex(op.side)]++;
              w.events.push({ type: 'TACKLE', side: op.side });
              if (op.side === 'USER' && w.autoSwitch) w.controlledId = op.id;
              break;
            }
          }
        }
      }
    } else {
      b.x += b.vx / SUB;
      b.y += b.vy / SUB;
      b.z += b.vz / SUB;

      if (b.z > 0) b.vz -= 0.19 / SUB;
      else {
        b.z = 0;
        if (Math.abs(b.vz) > 0.7) b.vz = -b.vz * 0.52;
        else b.vz = 0;
      }

      const friction = b.z > 2 ? 0.9975 : 0.9885;
      b.vx *= Math.pow(friction, 1 / SUB);
      b.vy *= Math.pow(friction, 1 / SUB);
      b.vy += b.spin / SUB;
      b.spin *= 0.985;
      b.rotationX += b.vx * 0.05;
      b.rotationY += b.vy * 0.05;

      // Assisted passing: gently steer the ball onto the intended receiver.
      if (b.passTo) {
        b.passTimer--;
        const target = getById(w, b.passTo);
        if (!target || target.sentOff || b.passTimer <= 0) {
          b.passTo = null;
        } else {
          const desired = Math.atan2(target.y - b.y, target.x - b.x);
          const current = Math.atan2(b.vy, b.vx);
          const turn = clamp(norm(desired - current), -0.05, 0.05);
          const speed = Math.hypot(b.vx, b.vy);
          const angle = current + turn;
          const keep = Math.max(speed, 4.6);
          b.vx = Math.cos(angle) * keep;
          b.vy = Math.sin(angle) * keep;
        }
      }

      if (w.pickupCd > 0) {
        active(w).forEach((p) => {
          const d = dist(p.x, p.y, b.x, b.y);
          if (d < 15 && d > 0.01 && b.z < 40) {
            const nx = (b.x - p.x) / d;
            const ny = (b.y - p.y) / d;
            b.x = p.x + nx * 15;
            b.y = p.y + ny * 15;
            b.vx = nx * Math.abs(b.vx) * 0.7;
            b.vy = ny * Math.abs(b.vy) * 0.7;
          }
        });
      } else {
        const claimant = active(w)
          .filter((p) => p.actionTimer <= 6 && dist(p.x, p.y, b.x, b.y) < 22 && b.z < 34)
          .sort((p1, p2) => dist(p1.x, p1.y, b.x, b.y) - dist(p2.x, p2.y, b.x, b.y))[0];
        if (claimant) {
          // A keeper may only pick the ball up when it was not played to him by a
          // teammate, and never straight after his own distribution.
          const backPass = !!w.lastTouch && w.lastTouch.side === claimant.side;
          const justReleased = !!w.gkRelease && w.gkRelease.id === claimant.id;
          if (claimant.isGK && !backPass && !justReleased) {
            beginGkHold(w, claimant);
          } else {
            b.ownerId = claimant.id;
            b.passTo = null;
            claimant.holdTimer = claimant.isGK ? 26 : 16;
            claimant.actionState = 'receive';
            claimant.actionTimer = 9;
            setTouch(w, claimant);
            if (claimant.side === 'USER' && w.autoSwitch && !claimant.isGK) w.controlledId = claimant.id;
          }
          w.incomingReceiver = null;
        }
      }
    }

    hitFrame(w);
    keeperInterception(w);
    if (handleBounds(w)) return;
  }

  if (w.pickupCd > 0) w.pickupCd--;
}

/* ================================================================== */
/* STEP                                                                */
/* ================================================================== */
export function stepWorld(w: World, input: InputState): MatchEvent[] {
  w.events = [];
  w.tick++;

  if (!w.live) {
    w.players.forEach((p) => { if (!p.sentOff) p.animFrame += 0.18; });
    return w.events;
  }

  if (w.passCd > 0) w.passCd--;

  const controlled = getById(w, w.controlledId);
  if (!controlled || controlled.isGK || controlled.sentOff) {
    const fallback = active(w).find((p) => p.side === 'USER' && !p.isGK);
    if (fallback) w.controlledId = fallback.id;
  }

  // Goalkeeper possession window: teams reset, then the keeper distributes.
  if (w.gkRelease) {
    w.gkRelease.timer--;
    if (w.gkRelease.timer <= 0) w.gkRelease = null;
  }

  if (w.gkHold) {
    w.gkHold.timer--;
    const keeper = active(w).find((p) => p.isGK && p.side === (w.gkHold as { side: Side }).side);
    if (!keeper || w.ball.ownerId !== keeper.id) {
      w.gkHold = null;
    } else if (w.gkHold.timer <= 0) {
      releaseFromKeeper(w, keeper);
      w.gkHold = null;
    }
  }

  handleRestart(w);
  updateControlled(w, input);
  updateAI(w);
  integratePlayers(w);
  updateReferee(w);

  if (!w.restart) updateBall(w);
  else { w.ball.x = w.restart.x; w.ball.y = w.restart.y; w.ball.z = 0; }

  const owner = getById(w, w.ball.ownerId);
  if (owner) w.stats.possession[sideIndex(owner.side)]++;

  const carrier = getById(w, w.controlledId);
  w.passTargetId = carrier && w.ball.ownerId === carrier.id
    ? (bestPassTarget(w, carrier, w.passMode === 'MANUAL')?.id ?? null)
    : null;

  return w.events;
}

/* ================================================================== */
/* REPLAY                                                              */
/* ================================================================== */
export interface Snapshot {
  bx: number; by: number; bz: number;
  rx: number; ry: number; rf: number; ra: number;
  p: { id: string; x: number; y: number; z: number; f: number; a: PitchPlayer['actionState']; anim: number; vx: number; vy: number }[];
}

export function captureSnapshot(w: World): Snapshot {
  return {
    bx: w.ball.x, by: w.ball.y, bz: w.ball.z,
    rx: w.referee.x, ry: w.referee.y, rf: w.referee.facingAngle, ra: w.referee.animFrame,
    p: active(w).map((p) => ({
      id: p.id, x: p.x, y: p.y, z: p.z, f: p.facingAngle,
      a: p.actionState, anim: p.animFrame, vx: p.vx, vy: p.vy,
    })),
  };
}

export function possessionPercent(stats: MatchStats): [number, number] {
  const total = stats.possession[0] + stats.possession[1];
  if (!total) return [50, 50];
  const user = Math.round((stats.possession[0] / total) * 100);
  return [user, 100 - user];
}
