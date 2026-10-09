import { PitchPlayer, Quality, StadiumId, Team } from '../types/game';
import { BALL_R, PITCH, Snapshot, World, WORLD } from '../game/engine';
import { drawPlayer3D } from './Player3DRenderer';

export interface Camera { x: number; y: number }

interface CrowdDot { x: number; y: number; t: number; r: number }

let crowdCache: CrowdDot[] | null = null;

interface StadiumTheme {
  bowl: string;
  grassA: string;
  grassB: string;
  board: string;
  accent: string;
  crowd: string[];
}

export const STADIUMS: Record<StadiumId, { name: string; blurb: string; theme: StadiumTheme }> = {
  ARENA: {
    name: 'Neon Arena',
    blurb: 'Enclosed night bowl with bright floodlights.',
    theme: {
      bowl: '#05070d', grassA: '#14823f', grassB: '#116b35', board: '#0b1220', accent: 'rgba(16,185,129,0.5)',
      crowd: ['#1e293b', '#334155', '#475569', '#0f172a', '#065f46'],
    },
  },
  COASTAL: {
    name: 'Coastal Park',
    blurb: 'Sea-breeze evening pitch with a blue-lit crowd.',
    theme: {
      bowl: '#040a14', grassA: '#15854a', grassB: '#0f6a3b', board: '#081426', accent: 'rgba(56,189,248,0.5)',
      crowd: ['#0c4a6e', '#075985', '#1e3a8a', '#0f172a', '#155e75'],
    },
  },
  HIGHLAND: {
    name: 'Highland Ground',
    blurb: 'Cooler turf, tighter stands, older floodlight towers.',
    theme: {
      bowl: '#070c08', grassA: '#2b7a3d', grassB: '#226633', board: '#111a12', accent: 'rgba(250,204,21,0.45)',
      crowd: ['#3f3f46', '#52525b', '#27272a', '#7f1d1d', '#1c1917'],
    },
  },
  NATIONAL: {
    name: 'National Stadium',
    blurb: 'Showpiece tournament venue with a full house.',
    theme: {
      bowl: '#0a0710', grassA: '#13864a', grassB: '#0f6b3c', board: '#15101f', accent: 'rgba(167,139,250,0.5)',
      crowd: ['#312e81', '#4c1d95', '#1e1b4b', '#7c2d12', '#0f172a'],
    },
  },
};

/** The referee's kit — deliberately distinct from every team kit. */
const REFEREE_TEAM: Team = {
  id: 'referee',
  name: 'Match Referee',
  shortName: 'REF',
  city: '',
  category: 'NATIONAL',
  primaryColor: '#111827',
  secondaryColor: '#FACC15',
  shortsColor: '#111827',
  socksColor: '#111827',
  gkColor: '#111827',
  pattern: 'solid',
  rating: 0,
  players: [],
};

function buildCrowd(): CrowdDot[] {
  const dots: CrowdDot[] = [];
  const rnd = (() => { let s = 99; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();
  const addBand = (x0: number, x1: number, y0: number, y1: number, count: number) => {
    for (let i = 0; i < count; i++) {
      dots.push({ x: x0 + rnd() * (x1 - x0), y: y0 + rnd() * (y1 - y0), t: Math.floor(rnd() * 5), r: 2 + rnd() * 1.8 });
    }
  };
  addBand(-WORLD.halfW, WORLD.halfW, -WORLD.halfH, -PITCH.halfH - 26, 620);
  addBand(-WORLD.halfW, WORLD.halfW, PITCH.halfH + 26, WORLD.halfH, 620);
  addBand(-WORLD.halfW, -PITCH.halfW - 34, -PITCH.halfH - 20, PITCH.halfH + 20, 300);
  addBand(PITCH.halfW + 34, WORLD.halfW, -PITCH.halfH - 20, PITCH.halfH + 20, 300);
  return dots;
}

export function computeScale(canvasW: number, canvasH: number, zoom: number) {
  return Math.min(canvasW / (WORLD.halfW * 2), canvasH / (WORLD.halfH * 2)) * zoom;
}

export function clampCamera(cam: Camera, canvasW: number, canvasH: number, scale: number) {
  const halfViewW = canvasW / 2 / scale;
  const halfViewH = canvasH / 2 / scale;
  const limitX = Math.max(0, WORLD.halfW - halfViewW);
  const limitY = Math.max(0, WORLD.halfH - halfViewH);
  cam.x = Math.max(-limitX, Math.min(limitX, cam.x));
  cam.y = Math.max(-limitY, Math.min(limitY, cam.y));
}

export function screenToWorld(
  clientX: number, clientY: number, rect: DOMRect,
  canvasW: number, canvasH: number, cam: Camera, scale: number
) {
  const displayScale = Math.min(rect.width / canvasW, rect.height / canvasH);
  const offsetX = (rect.width - canvasW * displayScale) / 2;
  const offsetY = (rect.height - canvasH * displayScale) / 2;
  const cx = (clientX - rect.left - offsetX) / displayScale;
  const cy = (clientY - rect.top - offsetY) / displayScale;
  return { x: (cx - canvasW / 2) / scale + cam.x, y: (cy - canvasH / 2) / scale + cam.y };
}

export function renderWorld(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  w: World,
  cam: Camera,
  scale: number,
  quality: Quality,
  snapshot: Snapshot | null,
  showIndicators: boolean,
  stadiumId: StadiumId
) {
  const theme = STADIUMS[stadiumId].theme;
  const sx = (wx: number) => canvasW / 2 + (wx - cam.x) * scale;
  const sy = (wy: number) => canvasH / 2 + (wy - cam.y) * scale;
  const high = quality === 'HIGH';
  const medium = quality !== 'LOW';

  ctx.fillStyle = theme.bowl;
  ctx.fillRect(0, 0, canvasW, canvasH);

  if (medium) {
    if (!crowdCache) crowdCache = buildCrowd();
    const flicker = Math.sin(w.tick * 0.05) * 0.06 + 0.94;
    ctx.globalAlpha = 0.85 * flicker;
    crowdCache.forEach((dot) => {
      const px = sx(dot.x);
      const py = sy(dot.y);
      if (px < -20 || px > canvasW + 20 || py < -20 || py > canvasH + 20) return;
      ctx.fillStyle = theme.crowd[dot.t];
      ctx.beginPath();
      ctx.arc(px, py, dot.r * scale, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  const boardPad = 20;
  ctx.fillStyle = theme.board;
  ctx.fillRect(sx(-PITCH.halfW - boardPad), sy(-PITCH.halfH - boardPad), (PITCH.halfW + boardPad) * 2 * scale, (PITCH.halfH + boardPad) * 2 * scale);
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx(-PITCH.halfW - boardPad), sy(-PITCH.halfH - boardPad), (PITCH.halfW + boardPad) * 2 * scale, (PITCH.halfH + boardPad) * 2 * scale);

  const pitchX = sx(-PITCH.halfW);
  const pitchY = sy(-PITCH.halfH);
  const pitchW = PITCH.halfW * 2 * scale;
  const pitchH = PITCH.halfH * 2 * scale;

  const stripes = 16;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? theme.grassA : theme.grassB;
    ctx.fillRect(pitchX + (i * pitchW) / stripes, pitchY, pitchW / stripes + 1, pitchH);
  }

  if (high) {
    const glow = ctx.createRadialGradient(
      pitchX + pitchW / 2, pitchY + pitchH / 2, pitchH * 0.1,
      pitchX + pitchW / 2, pitchY + pitchH / 2, pitchW * 0.75
    );
    glow.addColorStop(0, 'rgba(255,255,255,0.10)');
    glow.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = glow;
    ctx.fillRect(pitchX, pitchY, pitchW, pitchH);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.88)';
  ctx.lineWidth = Math.max(1.4, 2.4 * scale);
  ctx.strokeRect(pitchX, pitchY, pitchW, pitchH);
  ctx.beginPath();
  ctx.moveTo(sx(0), pitchY);
  ctx.lineTo(sx(0), pitchY + pitchH);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx(0), sy(0), PITCH.circle * scale, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  [[0, 0], [-PITCH.halfW + PITCH.penaltySpot, 0], [PITCH.halfW - PITCH.penaltySpot, 0]].forEach(([px, py]) => {
    ctx.beginPath();
    ctx.arc(sx(px), sy(py), 3 * scale, 0, Math.PI * 2);
    ctx.fill();
  });

  ([-1, 1] as const).forEach((dir) => {
    const lineX = PITCH.halfW * dir;
    ctx.strokeRect(sx(Math.min(lineX, lineX - PITCH.boxW * dir)), sy(-PITCH.boxH / 2), PITCH.boxW * scale, PITCH.boxH * scale);
    ctx.strokeRect(sx(Math.min(lineX, lineX - PITCH.sixW * dir)), sy(-PITCH.sixH / 2), PITCH.sixW * scale, PITCH.sixH * scale);
    ctx.beginPath();
    ctx.arc(sx(lineX - PITCH.penaltySpot * dir), sy(0), 72 * scale,
      dir === 1 ? Math.PI * 0.62 : -Math.PI * 0.38, dir === 1 ? Math.PI * 1.38 : Math.PI * 0.38);
    ctx.stroke();
    ([-1, 1] as const).forEach((vy) => {
      ctx.beginPath();
      ctx.arc(sx(lineX), sy(PITCH.halfH * vy), 14 * scale, 0, Math.PI * 2);
      ctx.stroke();
    });
  });

  const drawGoal = (dir: 1 | -1) => {
    const lineX = PITCH.halfW * dir;
    const backX = lineX + PITCH.goalDepth * dir;
    const left = Math.min(sx(lineX), sx(backX));
    const right = Math.max(sx(lineX), sx(backX));
    const top = sy(-PITCH.goalHalf);
    const bottom = sy(PITCH.goalHalf);

    ctx.fillStyle = 'rgba(2,6,23,0.55)';
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    const step = Math.max(5, 8 * scale);
    for (let x = left; x <= right; x += step) { ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); }
    for (let y = top; y <= bottom; y += step) { ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); }

    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = Math.max(3, 5 * scale);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx(lineX), top);
    ctx.lineTo(sx(lineX), bottom);
    ctx.stroke();
  };
  drawGoal(1);
  drawGoal(-1);

  if (high) {
    ctx.globalCompositeOperation = 'lighter';
    ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).forEach(([dx, dy]) => {
      const gx = sx(dx * PITCH.halfW * 0.72);
      const gy = sy(dy * PITCH.halfH * 0.72);
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, 320 * scale);
      g.addColorStop(0, 'rgba(226,255,240,0.14)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(gx - 320 * scale, gy - 320 * scale, 640 * scale, 640 * scale);
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  /* Restart marker (free kick / penalty / corner spot). */
  if (w.restart && !snapshot) {
    ctx.save();
    ctx.strokeStyle = 'rgba(250,204,21,0.9)';
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx(w.restart.x), sy(w.restart.y), 16 * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const snapById = new Map(snapshot ? snapshot.p.map((item) => [item.id, item]) : []);
  const ballX = snapshot ? snapshot.bx : w.ball.x;
  const ballY = snapshot ? snapshot.by : w.ball.y;
  const ballZ = snapshot ? snapshot.bz : w.ball.z;

  const controlled = w.players.find((p) => p.id === w.controlledId);
  if (showIndicators && controlled && w.ball.ownerId === controlled.id) {
    ctx.save();
    ctx.strokeStyle = 'rgba(52,211,153,0.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    ctx.moveTo(sx(ballX), sy(ballY));
    ctx.lineTo(sx(ballX + Math.cos(controlled.facingAngle) * 150), sy(ballY + Math.sin(controlled.facingAngle) * 150));
    ctx.stroke();

    // Pass line to the player who will receive the ball.
    const target = w.players.find((p) => p.id === w.passTargetId);
    if (target) {
      ctx.strokeStyle = 'rgba(56,189,248,0.55)';
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(sx(ballX), sy(ballY));
      ctx.lineTo(sx(target.x), sy(target.y));
      ctx.stroke();
    }
    ctx.restore();
  }

  type Entity =
    | { y: number; kind: 'P'; player: PitchPlayer }
    | { y: number; kind: 'B' }
    | { y: number; kind: 'R' };

  const entities: Entity[] = w.players
    .filter((player) => !player.sentOff)
    .map((player) => {
      const snap = snapById.get(player.id);
      return { y: snap ? snap.y : player.y, kind: 'P' as const, player };
    });
  entities.push({ y: ballY, kind: 'B' });
  entities.push({ y: snapshot ? snapshot.ry : w.referee.y, kind: 'R' });
  entities.sort((a, b) => a.y - b.y);

  entities.forEach((entity) => {
    if (entity.kind === 'P') {
      const base = entity.player;
      const snap = snapById.get(base.id);
      const view: PitchPlayer = snap
        ? { ...base, x: snap.x, y: snap.y, z: snap.z, facingAngle: snap.f, actionState: snap.a, animFrame: snap.anim, vx: snap.vx, vy: snap.vy }
        : base;
      const team: Team = base.side === 'USER' ? w.userTeam : w.cpuTeam;
      drawPlayer3D(
        ctx, view, team, sx(view.x), sy(view.y), scale,
        showIndicators && base.id === w.controlledId,
        showIndicators && base.id === w.passTargetId
      );

      // Caution marker on booked players.
      if (base.yellowCards > 0 && !snapshot) {
        ctx.fillStyle = '#FACC15';
        ctx.fillRect(sx(view.x) + 13 * scale, sy(view.y) - 62 * scale, 4.5 * scale, 6.5 * scale);
      }
    } else if (entity.kind === 'R') {
      const ref = w.referee;
      const rx = snapshot ? snapshot.rx : ref.x;
      const ry = snapshot ? snapshot.ry : ref.y;
      const refPlayer: PitchPlayer = {
        id: 'referee', teamId: 'referee', side: 'CPU', isGK: false,
        name: 'Referee', number: 0, role: 'MID',
        appearance: {
          skinTone: '#C68642', hairColor: '#1A1110', hairStyle: 'buzz_cut',
          bootColor: '#111827', heightScale: 1.0, buildWidth: 0.98,
        },
        x: rx, y: ry, z: 0, vx: ref.vx, vy: ref.vy, vz: 0,
        facingAngle: snapshot ? snapshot.rf : ref.facingAngle,
        actionState: Math.hypot(ref.vx, ref.vy) > 1.4 ? 'run' : 'idle',
        animFrame: snapshot ? snapshot.ra : ref.animFrame,
        actionTimer: 0, tackleCd: 0, decisionCd: 0, holdTimer: 0, stamina: 100,
        speedRating: 70, shootRating: 0, passRating: 0,
        homeX: 0, homeY: 0, yellowCards: 0, sentOff: false,
      };
      drawPlayer3D(ctx, refPlayer, REFEREE_TEAM, sx(rx), sy(ry), scale * 0.96, false, false);

      // Card animation.
      if (ref.cardTimer > 0 && ref.cardType) {
        const lift = Math.min(1, (110 - ref.cardTimer) / 14);
        const cx = sx(rx) + 16 * scale;
        const cy = sy(ry) - (52 + 16 * lift) * scale;
        ctx.save();
        ctx.fillStyle = ref.cardType === 'YELLOW' ? '#FACC15' : '#EF4444';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1.2;
        ctx.fillRect(cx, cy, 10 * scale, 14 * scale);
        ctx.strokeRect(cx, cy, 10 * scale, 14 * scale);
        ctx.restore();
      }

      // Whistle flash.
      if (ref.whistleTimer > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(0.8, ref.whistleTimer / 30);
        ctx.strokeStyle = '#FDE047';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx(rx), sy(ry) - 46 * scale, (34 - ref.whistleTimer * 0.5) * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    } else {
      const bx = sx(ballX);
      const by = sy(ballY);
      const bz = ballZ * scale;
      const r = BALL_R * scale;

      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      const shrink = Math.max(0.45, 1 - ballZ * 0.008);
      ctx.ellipse(bx + 2 * scale, by + 2 * scale, r * shrink, r * 0.55 * shrink, 0, 0, Math.PI * 2);
      ctx.fill();

      const grad = ctx.createRadialGradient(bx - r * 0.35, by - bz - r * 0.35, r * 0.1, bx, by - bz, r);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.7, '#e2e8f0');
      grad.addColorStop(1, '#8c9bad');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by - bz, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(bx + Math.cos(w.ball.rotationX) * r * 0.35, by - bz + Math.sin(w.ball.rotationY) * r * 0.35, r * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
