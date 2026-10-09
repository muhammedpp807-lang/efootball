import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Flag, Pause, Play, Repeat2, Whistle } from 'lucide-react';
import { MatchStats, Settings, Team } from '../types/game';
import {
  captureSnapshot, createWorld, DIFFICULTY, doPass, doShoot, doTackle, kickOff,
  InputState, MatchEvent, possessionPercent, setupKickoff, Snapshot, stepWorld, switchPlayer, World,
} from '../game/engine';
import { clampCamera, Camera, computeScale, renderWorld, screenToWorld, STADIUMS } from './PitchRenderer';
import { sound } from '../utils/sound';

const CANVAS_W = 1280;
const CANVAS_H = 720;

export interface MatchResult {
  userGoals: number;
  cpuGoals: number;
  pens?: [number, number];
}

interface MatchScreenProps {
  userTeam: Team;
  cpuTeam: Team;
  settings: Settings;
  competitionLabel: string;
  matchNumberLabel: string;
  official: boolean;
  knockout: boolean;
  onExit: () => void;
  onFinish: (result: MatchResult) => void;
}

type Phase = 'PREMATCH' | 'FIRST' | 'HALFTIME' | 'SECOND' | 'GOAL' | 'EXTRA' | 'PENS' | 'FULLTIME';

const KEY_MAP: Record<string, string> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
};

export function MatchScreen({
  userTeam, cpuTeam, settings, competitionLabel, matchNumberLabel, official, knockout, onExit, onFinish,
}: MatchScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldLazy = useRef<World | null>(null);
  if (!worldLazy.current) {
    worldLazy.current = createWorld(
      userTeam, cpuTeam, settings.difficulty, settings.autoSwitch, settings.passMode, settings.strictness
    );
  }
  const worldRef = worldLazy as React.MutableRefObject<World>;

  const camRef = useRef<Camera>({ x: 0, y: 0 });
  const keysRef = useRef<Record<string, boolean>>({});
  const padRef = useRef<Record<string, boolean>>({});
  const pointerRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const clockRef = useRef(0);
  const phaseRef = useRef<Phase>('PREMATCH');
  const replayRef = useRef<Snapshot[]>([]);
  const replayPlayRef = useRef<{ frames: Snapshot[]; index: number } | null>(null);
  const finishedRef = useRef(false);
  const pausedRef = useRef(false);
  const resumePhaseRef = useRef<Phase>('FIRST');

  const [phase, setPhaseState] = useState<Phase>('PREMATCH');
  const [score, setScore] = useState({ user: 0, cpu: 0 });
  const [clock, setClock] = useState(0);
  const [goalBanner, setGoalBanner] = useState<{ name: string; side: 'USER' | 'CPU'; own: boolean } | null>(null);
  const [decision, setDecision] = useState<{ text: string; card: 'YELLOW' | 'RED' | null } | null>(null);
  const [statTick, setStatTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [controlled, setControlled] = useState(worldRef.current.controlledId);
  const [gkHolding, setGkHolding] = useState<'USER' | 'CPU' | null>(null);
  const [pens, setPens] = useState<{ user: boolean[]; cpu: boolean[]; turn: 'USER' | 'CPU'; done: boolean }>({
    user: [], cpu: [], turn: 'USER', done: false,
  });

  const halfLength = settings.halfLengthSec;
  const extraLength = Math.round(settings.halfLengthSec / 2);

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  useEffect(() => {
    sound.setSfx(settings.sfx);
    sound.setCrowd(settings.crowd);
    if (settings.crowd) sound.startCrowd();
    return () => sound.stopCrowd();
  }, [settings.sfx, settings.crowd]);

  /* ----------------------------- input ----------------------------- */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const mapped = KEY_MAP[e.code];
      if (mapped) { keysRef.current[mapped] = true; e.preventDefault(); }
      if (['Space', 'KeyJ', 'KeyK', 'Tab', 'Escape'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;

      const w = worldRef.current;
      if (!w.live || pausedRef.current) {
        if (e.code === 'Escape') setPaused((p) => !p);
        return;
      }
      if (e.code === 'Space') doPass(w);
      else if (e.code === 'KeyJ') doShoot(w);
      else if (e.code === 'KeyK') doTackle(w);
      else if (e.code === 'Tab') switchPlayer(w);
      else if (e.code === 'Escape') setPaused((p) => !p);
    };
    const up = (e: KeyboardEvent) => {
      const mapped = KEY_MAP[e.code];
      if (mapped) keysRef.current[mapped] = false;
    };
    const blur = () => { keysRef.current = {}; padRef.current = {}; };

    window.addEventListener('keydown', down, { passive: false });
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  /* --------------------------- match flow -------------------------- */
  const onGoal = useCallback((event: Extract<MatchEvent, { type: 'GOAL' }>) => {
    const w = worldRef.current;
    setScore({ user: w.score.user, cpu: w.score.cpu });
    setGoalBanner({ name: event.scorer, side: event.side, own: event.ownGoal });
    sound.playGoal();

    // Engine has already stopped play and set awaitingKickoff.
    resumePhaseRef.current = phaseRef.current === 'EXTRA' ? 'EXTRA' : (clockRef.current < halfLength ? 'FIRST' : 'SECOND');
    const frames = replayRef.current.slice(-110);
    replayPlayRef.current = frames.length > 20 ? { frames, index: 0 } : null;
    setPhase('GOAL');
  }, [halfLength, setPhase]);

  const handleEvents = useCallback((events: MatchEvent[]) => {
    events.forEach((event) => {
      switch (event.type) {
        case 'GOAL': onGoal(event); break;
        case 'SHOT': sound.playKick(1); break;
        case 'PASS': sound.playPass(); break;
        case 'POST': sound.playPost(); break;
        case 'SAVE':
          sound.playSave();
          if (event.caught) setGkHolding(event.side);
          break;
        case 'RESTART': {
          sound.playWhistle(false);
          const who = event.side === 'USER' ? userTeam.shortName : cpuTeam.shortName;
          const label: Record<string, string> = {
            THROW: 'Throw-in', CORNER: 'Corner', GOALKICK: 'Goal kick',
            FREEKICK: 'Free kick', PENALTY: 'Penalty kick',
          };
          setDecision({ text: `${label[event.kind]} — ${who}`, card: null });
          window.setTimeout(() => setDecision(null), 2200);
          break;
        }
        case 'DECISION': {
          sound.playWhistle(false);
          setDecision({ text: event.text, card: event.card });
          window.setTimeout(() => setDecision(null), 3000);
          break;
        }
        default: break;
      }
    });
  }, [onGoal, userTeam.shortName, cpuTeam.shortName]);

  const finishMatch = useCallback(() => {
    const w = worldRef.current;
    w.live = false;
    if (knockout && w.score.user === w.score.cpu) {
      if (phaseRef.current === 'SECOND') {
        clockRef.current = halfLength * 2;
        setupKickoff(w, 'USER');
        w.awaitingKickoff = 'USER';
        sound.playWhistle(true);
        setPhase('EXTRA');
        kickOff(w, 'USER');
        return;
      }
      sound.playWhistle(true);
      setPhase('PENS');
      return;
    }
    sound.playWhistle(true);
    setPhase('FULLTIME');
  }, [knockout, halfLength, setPhase]);

  /* --------------------------- game loop --------------------------- */
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let statAcc = 0;
    const STEP = 1000 / 60;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const delta = Math.min(100, now - last);
      last = now;

      const w = worldRef.current;
      const simulate = w.live && !pausedRef.current;

      if (simulate) {
        acc += delta;
        let steps = 0;
        while (acc >= STEP && steps < 5) {
          const input: InputState = {
            up: !!(keysRef.current.up || padRef.current.up),
            down: !!(keysRef.current.down || padRef.current.down),
            left: !!(keysRef.current.left || padRef.current.left),
            right: !!(keysRef.current.right || padRef.current.right),
            sprint: !!(keysRef.current.sprint || padRef.current.sprint),
            pointer: pointerRef.current.active ? pointerRef.current : null,
          };
          handleEvents(stepWorld(w, input));
          replayRef.current.push(captureSnapshot(w));
          if (replayRef.current.length > 140) replayRef.current.shift();
          acc -= STEP;
          steps++;
          if (!w.live) break;
        }

        // The clock only advances while the ball is in play.
        if (w.live) clockRef.current += delta / 1000;
        statAcc += delta;
        if (statAcc > 220) {
          statAcc = 0;
          setClock(clockRef.current);
          setStatTick((t) => t + 1);
          setControlled(w.controlledId);
          setGkHolding(w.gkHold ? w.gkHold.side : null);
        }

        if (phaseRef.current === 'FIRST' && clockRef.current >= halfLength) {
          clockRef.current = halfLength;
          setClock(halfLength);
          w.live = false;
          sound.playWhistle(true);
          setPhase('HALFTIME');
        } else if (phaseRef.current === 'SECOND' && clockRef.current >= halfLength * 2) {
          clockRef.current = halfLength * 2;
          setClock(halfLength * 2);
          finishMatch();
        } else if (phaseRef.current === 'EXTRA' && clockRef.current >= halfLength * 2 + extraLength) {
          clockRef.current = halfLength * 2 + extraLength;
          setClock(clockRef.current);
          finishMatch();
        }
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const scale = computeScale(CANVAS_W, CANVAS_H, settings.cameraZoom);
      const replay = replayPlayRef.current;
      let snapshot: Snapshot | null = null;
      if (replay) {
        snapshot = replay.frames[Math.floor(replay.index)];
        replay.index += 0.5;
        if (replay.index >= replay.frames.length) replay.index = replay.frames.length - 1;
      }

      const focusX = snapshot ? snapshot.bx : w.ball.x;
      const focusY = snapshot ? snapshot.by : w.ball.y;
      camRef.current.x += (focusX * 0.94 - camRef.current.x) * 0.075;
      camRef.current.y += (focusY * 0.85 - camRef.current.y) * 0.075;
      clampCamera(camRef.current, CANVAS_W, CANVAS_H, scale);

      renderWorld(ctx, CANVAS_W, CANVAS_H, w, camRef.current, scale, settings.quality, snapshot, !snapshot, settings.stadium);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [handleEvents, finishMatch, halfLength, extraLength, settings.cameraZoom, settings.quality, settings.stadium, setPhase]);

  /* --------------------------- pointer ----------------------------- */
  const toWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const scale = computeScale(CANVAS_W, CANVAS_H, settings.cameraZoom);
    return screenToWorld(clientX, clientY, canvas.getBoundingClientRect(), CANVAS_W, CANVAS_H, camRef.current, scale);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toWorld(e.clientX, e.clientY);
    pointerRef.current = { ...point, active: true };
    if (e.button === 2) doShoot(worldRef.current);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current.active) return;
    const point = toWorld(e.clientX, e.clientY);
    pointerRef.current = { ...point, active: true };
  };
  const endPointer = () => { pointerRef.current.active = false; };

  const hold = (key: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      padRef.current[key] = true;
    },
    onPointerUp: () => { padRef.current[key] = false; },
    onPointerCancel: () => { padRef.current[key] = false; },
    onPointerLeave: () => { padRef.current[key] = false; },
  });

  /* --------------------------- penalties --------------------------- */
  const takePenalty = (choice: 'L' | 'C' | 'R') => {
    setPens((state) => {
      if (state.done) return state;
      const keeper = ['L', 'C', 'R'][Math.floor(Math.random() * 3)];
      const profile = DIFFICULTY[settings.difficulty];
      const user = [...state.user];
      const cpu = [...state.cpu];

      if (state.turn === 'USER') {
        const scored = keeper !== choice || Math.random() < 0.45;
        user.push(scored);
        if (scored) sound.playGoal(); else sound.playSave();
      } else {
        const cpuAim = ['L', 'C', 'R'][Math.floor(Math.random() * 3)];
        const saved = cpuAim === choice && Math.random() < 0.55;
        const scored = !saved && Math.random() < 0.55 + profile.shotAcc * 0.35;
        cpu.push(scored);
        if (scored) sound.playGoal(); else sound.playSave();
      }

      const next = { ...state, user, cpu, turn: state.turn === 'USER' ? ('CPU' as const) : ('USER' as const) };
      const u = user.filter(Boolean).length;
      const c = cpu.filter(Boolean).length;
      const rounds = Math.max(user.length, cpu.length);
      if (user.length === cpu.length && rounds >= 5 && u !== c) next.done = true;
      return next;
    });
  };

  const penScore = useMemo(() => ({
    user: pens.user.filter(Boolean).length,
    cpu: pens.cpu.filter(Boolean).length,
  }), [pens]);

  useEffect(() => {
    if (phase !== 'PENS' || !pens.done || finishedRef.current) return;
    finishedRef.current = true;
    const w = worldRef.current;
    window.setTimeout(
      () => onFinish({ userGoals: w.score.user, cpuGoals: w.score.cpu, pens: [penScore.user, penScore.cpu] }),
      900
    );
  }, [phase, pens.done, penScore, onFinish]);

  /* ----------------------------- UI -------------------------------- */
  const world = worldRef.current;
  const stats = world.stats;
  const [posUser, posCpu] = possessionPercent(stats);
  void statTick;

  const displayClock = Math.min(clock, halfLength * 2 + (phase === 'EXTRA' ? extraLength : 0));
  const mm = String(Math.floor(displayClock / 60)).padStart(2, '0');
  const ss = String(Math.floor(displayClock % 60)).padStart(2, '0');
  const periodLabel = phase === 'EXTRA' ? 'EXTRA TIME' : displayClock < halfLength ? '1ST HALF' : '2ND HALF';
  const controlledPlayer = world.players.find((p) => p.id === controlled);

  const startMatch = () => {
    sound.startCrowd();
    sound.playWhistle(false);
    kickOff(worldRef.current, 'USER');
    setPhase('FIRST');
  };

  const resumeAfterGoal = () => {
    replayPlayRef.current = null;
    setGoalBanner(null);
    sound.playWhistle(false);
    kickOff(worldRef.current);
    setPhase(resumePhaseRef.current);
  };

  const startSecondHalf = () => {
    sound.playWhistle(false);
    setupKickoff(worldRef.current, 'CPU');
    kickOff(worldRef.current, 'CPU');
    setPhase('SECOND');
  };

  const confirmResult = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinish({ userGoals: world.score.user, cpuGoals: world.score.cpu });
  };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-[#05070d] text-white" style={{ touchAction: 'none' }}>
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="absolute inset-0 h-full w-full object-contain"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Scoreboard */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2 sm:p-3">
        <div className="pointer-events-auto flex items-stretch overflow-hidden rounded-xl border border-white/15 bg-[#060b16]/95 shadow-2xl backdrop-blur">
          <button onClick={onExit} className="px-2.5 text-slate-400 transition hover:bg-white/10 hover:text-white" title="Leave match">
            <ArrowLeft className="size-4" />
          </button>
          <ScoreSide name={userTeam.shortName} flag={userTeam.flag} color={userTeam.primaryColor} goals={score.user} tag="YOU" accent />
          <div className="flex min-w-[104px] flex-col items-center justify-center border-x border-white/10 bg-black/40 px-3 py-1.5">
            <span className="text-[9px] font-black uppercase tracking-[.18em] text-emerald-400">{periodLabel}</span>
            <span className="font-mono text-lg font-black tabular-nums">{mm}:{ss}</span>
            <span className="text-[8px] font-bold uppercase tracking-wider text-slate-500">{matchNumberLabel}</span>
          </div>
          <ScoreSide name={cpuTeam.shortName} flag={cpuTeam.flag} color={cpuTeam.primaryColor} goals={score.cpu} tag="CPU" reverse />
          <button onClick={() => setPaused((p) => !p)} className="px-2.5 text-slate-400 transition hover:bg-white/10 hover:text-white" title="Pause">
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </button>
        </div>
      </div>

      {/* Possession + discipline */}
      <div className="pointer-events-none absolute left-1/2 top-[74px] w-[240px] -translate-x-1/2 sm:top-[82px]">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-black/60">
          <div className="bg-emerald-400" style={{ width: `${posUser}%` }} />
          <div className="bg-rose-400" style={{ width: `${posCpu}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[9px] font-black text-slate-400">
          <span>{posUser}% POSS</span>
          <span className="flex items-center gap-1.5">
            {stats.yellows[0] + stats.yellows[1] > 0 && <span className="text-amber-300">🟨 {stats.yellows[0]}-{stats.yellows[1]}</span>}
            {stats.reds[0] + stats.reds[1] > 0 && <span className="text-rose-400">🟥 {stats.reds[0]}-{stats.reds[1]}</span>}
          </span>
          <span>{posCpu}%</span>
        </div>
      </div>

      {/* Referee decision toast */}
      {decision && (
        <div className="pointer-events-none absolute left-1/2 top-28 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-white/15 bg-black/85 px-3 py-2 text-[11px] font-black uppercase tracking-wider">
          {decision.card && (
            <span className={`inline-block h-4 w-3 rounded-sm ${decision.card === 'YELLOW' ? 'bg-amber-400' : 'bg-rose-500'}`} />
          )}
          <span className="text-amber-300">{decision.text}</span>
        </div>
      )}

      {gkHolding && !decision && (
        <div className="pointer-events-none absolute left-1/2 top-28 -translate-x-1/2 rounded-lg bg-black/80 px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-sky-300">
          {gkHolding === 'USER'
            ? 'Your keeper has the ball — press PASS to distribute'
            : 'Keeper has the ball — teams resetting'}
        </div>
      )}

      {/* Controlled player */}
      <div className="pointer-events-none absolute bottom-2 left-2 rounded-lg border border-emerald-400/30 bg-black/70 px-2.5 py-1.5 text-[10px] sm:bottom-3 sm:left-3">
        <span className="text-slate-400">CONTROL </span>
        <span className="font-black text-emerald-400">
          {controlledPlayer ? `${controlledPlayer.number} ${controlledPlayer.name}` : '—'}
        </span>
      </div>

      {/* Touch controls */}
      {world.live && !paused && (
        <>
          <div className="absolute bottom-16 left-3 grid grid-cols-3 grid-rows-3 gap-1 opacity-90 sm:bottom-20 sm:left-6">
            <span />
            <PadButton label="▲" {...hold('up')} />
            <span />
            <PadButton label="◀" {...hold('left')} />
            <PadButton label="RUN" accent {...hold('sprint')} />
            <PadButton label="▶" {...hold('right')} />
            <span />
            <PadButton label="▼" {...hold('down')} />
            <span />
          </div>
          <div className="absolute bottom-16 right-3 grid grid-cols-2 gap-2 opacity-95 sm:bottom-20 sm:right-6">
            <ActionButton label="PASS" color="bg-sky-500" onPress={() => doPass(worldRef.current)} />
            <ActionButton label="SHOOT" color="bg-rose-500" onPress={() => doShoot(worldRef.current)} />
            <ActionButton label="SWITCH" color="bg-slate-700" small onPress={() => switchPlayer(worldRef.current)} />
            <ActionButton label="TACKLE" color="bg-amber-500" small dark onPress={() => doTackle(worldRef.current)} />
          </div>
        </>
      )}

      {/* ---------------------------- Overlays --------------------------- */}
      {phase === 'PREMATCH' && (
        <Overlay>
          <p className="text-[10px] font-black uppercase tracking-[.3em] text-emerald-400">{competitionLabel}</p>
          <h2 className="mt-2 flex items-center justify-center gap-2 text-2xl font-black tracking-tight sm:text-3xl">
            {userTeam.flag && <span>{userTeam.flag}</span>}
            {userTeam.shortName} <span className="text-slate-500">vs</span> {cpuTeam.shortName}
            {cpuTeam.flag && <span>{cpuTeam.flag}</span>}
          </h2>

          <div className={`mt-2 inline-block rounded px-2 py-1 text-[9px] font-black uppercase tracking-wider ${official ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/10 text-slate-400'}`}>
            {matchNumberLabel}
          </div>

          <div className="mt-4 grid gap-2 text-left sm:grid-cols-2">
            <InfoBox icon={<Whistle className="size-3.5" />} title="Match officials">
              <p className="text-[11px] font-bold text-slate-200">{world.referee.name}</p>
              <p className="text-[10px] text-slate-500">{world.referee.assistants[0]}</p>
              <p className="text-[10px] text-slate-500">{world.referee.assistants[1]}</p>
            </InfoBox>
            <InfoBox icon={<Flag className="size-3.5" />} title="Match setup">
              <p className="text-[11px] font-bold text-slate-200">{STADIUMS[settings.stadium].name}</p>
              <p className="text-[10px] text-slate-500">{settings.difficulty} · {halfLength}s halves</p>
              <p className="text-[10px] text-slate-500">
                {settings.passMode === 'ASSISTED' ? 'Assisted passing' : 'Manual passing'} · {settings.strictness.toLowerCase()} referee
              </p>
            </InfoBox>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 text-left sm:grid-cols-3">
            {[['Arrows / WASD', 'Move'], ['Space', 'Pass'], ['J', 'Shoot'], ['K', 'Tackle'], ['Shift', 'Sprint'], ['Tab', 'Switch']].map(([k, a]) => (
              <div key={k} className="bg-[#0a1120] px-3 py-2">
                <p className="text-[9px] font-black uppercase tracking-wider text-emerald-400">{k}</p>
                <p className="text-[11px] font-bold text-slate-300">{a}</p>
              </div>
            ))}
          </div>

          <button onClick={startMatch} className="mt-5 w-full rounded-lg bg-emerald-400 py-3 text-xs font-black uppercase tracking-[.16em] text-slate-950 transition hover:bg-white">
            Kick off
          </button>
        </Overlay>
      )}

      {phase === 'GOAL' && goalBanner && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/35">
          <div className="absolute left-4 top-24 rounded bg-black/70 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-amber-300">
            <Repeat2 className="mr-1 inline size-3" /> Goal replay
          </div>
          <div className="rounded-2xl border-2 border-white/30 bg-gradient-to-r from-emerald-600 to-teal-600 px-10 py-5 text-center shadow-2xl">
            <p className="text-5xl font-black italic tracking-tighter sm:text-7xl">GOAL!</p>
            <p className="mt-1 text-sm font-black uppercase tracking-wider">
              {goalBanner.own ? 'Own goal · ' : ''}{goalBanner.name}
            </p>
            <p className="mt-2 text-xs font-black">
              {userTeam.shortName} {score.user} — {score.cpu} {cpuTeam.shortName}
            </p>
          </div>
          <button onClick={resumeAfterGoal} className="mt-5 rounded-lg bg-white px-8 py-3 text-xs font-black uppercase tracking-[.16em] text-slate-950 transition hover:bg-emerald-300">
            Kick off
          </button>
        </div>
      )}

      {phase === 'HALFTIME' && (
        <Overlay>
          <p className="text-[10px] font-black uppercase tracking-[.3em] text-amber-400">Half time</p>
          <ScoreLine home={userTeam.name} away={cpuTeam.name} hg={score.user} ag={score.cpu} />
          <StatTable stats={stats} posUser={posUser} posCpu={posCpu} />
          <button onClick={startSecondHalf} className="mt-4 w-full rounded-lg bg-emerald-400 py-3 text-xs font-black uppercase tracking-[.16em] text-slate-950 transition hover:bg-white">
            Start second half
          </button>
        </Overlay>
      )}

      {phase === 'PENS' && (
        <Overlay>
          <p className="text-[10px] font-black uppercase tracking-[.3em] text-amber-400">Penalty shootout</p>
          <ScoreLine home={userTeam.name} away={cpuTeam.name} hg={penScore.user} ag={penScore.cpu} />
          <div className="mt-3 space-y-2 text-left">
            <PenRow label={userTeam.shortName} kicks={pens.user} />
            <PenRow label={cpuTeam.shortName} kicks={pens.cpu} />
          </div>
          {!pens.done ? (
            <>
              <p className="mt-4 text-xs font-bold text-slate-300">
                {pens.turn === 'USER' ? 'Pick your corner' : 'Pick your dive'}
              </p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(['L', 'C', 'R'] as const).map((side) => (
                  <button key={side} onClick={() => takePenalty(side)} className="rounded-lg bg-white/10 py-3 text-xs font-black uppercase transition hover:bg-emerald-400 hover:text-slate-950">
                    {side === 'L' ? 'Left' : side === 'C' ? 'Centre' : 'Right'}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="mt-4 text-sm font-black text-emerald-400">
              {penScore.user > penScore.cpu ? `${userTeam.name} win the shootout` : `${cpuTeam.name} win the shootout`}
            </p>
          )}
        </Overlay>
      )}

      {phase === 'FULLTIME' && (
        <Overlay>
          <p className="text-[10px] font-black uppercase tracking-[.3em] text-emerald-400">Full time</p>
          <ScoreLine home={userTeam.name} away={cpuTeam.name} hg={score.user} ag={score.cpu} />
          <p className="mt-1 text-xs font-bold text-slate-400">
            {score.user > score.cpu ? 'You won the match' : score.user === score.cpu ? 'The match ended level' : 'You lost the match'}
          </p>
          <StatTable stats={stats} posUser={posUser} posCpu={posCpu} />
          <button onClick={confirmResult} className="mt-4 w-full rounded-lg bg-emerald-400 py-3 text-xs font-black uppercase tracking-[.16em] text-slate-950 transition hover:bg-white">
            Confirm result
          </button>
        </Overlay>
      )}

      {paused && phase !== 'PREMATCH' && phase !== 'FULLTIME' && phase !== 'GOAL' && (
        <Overlay>
          <p className="text-[10px] font-black uppercase tracking-[.3em] text-emerald-400">Paused</p>
          <h3 className="mt-2 text-2xl font-black">Match paused</h3>
          <div className="mt-5 flex gap-2">
            <button onClick={() => setPaused(false)} className="flex-1 rounded-lg bg-emerald-400 py-3 text-xs font-black uppercase text-slate-950">Resume</button>
            <button onClick={onExit} className="flex-1 rounded-lg bg-white/10 py-3 text-xs font-black uppercase">Quit match</button>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function ScoreSide({ name, flag, color, goals, tag, accent, reverse }: {
  name: string; flag?: string; color: string; goals: number; tag: string; accent?: boolean; reverse?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 ${reverse ? 'flex-row-reverse' : ''}`}>
      {flag ? <span className="text-base leading-none">{flag}</span>
        : <span className="size-3.5 rounded-full ring-2 ring-white/25" style={{ background: color }} />}
      <div className={reverse ? 'text-left' : 'text-right'}>
        <p className={`text-[8px] font-black uppercase tracking-wider ${accent ? 'text-emerald-400' : 'text-slate-500'}`}>{tag}</p>
        <p className="text-sm font-black leading-none">{name}</p>
      </div>
      <p className="px-1 text-2xl font-black tabular-nums">{goals}</p>
    </div>
  );
}

function InfoBox({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[.03] p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider text-emerald-400">
        {icon}{title}
      </p>
      {children}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#070c17]/95 p-5 text-center shadow-2xl">{children}</div>
    </div>
  );
}

function ScoreLine({ home, away, hg, ag }: { home: string; away: string; hg: number; ag: number }) {
  return (
    <div className="mt-3 flex items-center justify-center gap-4 rounded-xl bg-black/50 px-4 py-3">
      <div className="flex-1 text-right text-[11px] font-bold text-slate-300">{home}</div>
      <div className="text-2xl font-black tabular-nums">{hg} - {ag}</div>
      <div className="flex-1 text-left text-[11px] font-bold text-slate-300">{away}</div>
    </div>
  );
}

function StatTable({ stats, posUser, posCpu }: { stats: MatchStats; posUser: number; posCpu: number }) {
  const rows: [string, number | string, number | string][] = [
    ['Possession', `${posUser}%`, `${posCpu}%`],
    ['Shots', stats.shots[0], stats.shots[1]],
    ['On target', stats.onTarget[0], stats.onTarget[1]],
    ['Passes', stats.passes[0], stats.passes[1]],
    ['Tackles', stats.tackles[0], stats.tackles[1]],
    ['Saves', stats.saves[0], stats.saves[1]],
    ['Corners', stats.corners[0], stats.corners[1]],
    ['Fouls', stats.fouls[0], stats.fouls[1]],
    ['Cards', `${stats.yellows[0]}/${stats.reds[0]}`, `${stats.yellows[1]}/${stats.reds[1]}`],
  ];
  return (
    <div className="mt-3 max-h-56 space-y-1 overflow-y-auto text-[11px]">
      {rows.map(([label, a, b]) => (
        <div key={label} className="flex items-center justify-between rounded bg-white/[.04] px-3 py-1.5">
          <span className="w-12 text-left font-black text-emerald-400">{a}</span>
          <span className="font-bold uppercase tracking-wider text-slate-400">{label}</span>
          <span className="w-12 text-right font-black text-rose-400">{b}</span>
        </div>
      ))}
    </div>
  );
}

function PenRow({ label, kicks }: { label: string; kicks: boolean[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-[10px] font-black text-slate-400">{label}</span>
      <div className="flex gap-1">
        {Array.from({ length: Math.max(5, kicks.length) }).map((_, i) => (
          <span key={i} className={`size-3.5 rounded-full border ${i >= kicks.length ? 'border-white/20' : kicks[i] ? 'border-emerald-400 bg-emerald-400' : 'border-rose-400 bg-rose-400/30'}`} />
        ))}
      </div>
    </div>
  );
}

function PadButton({ label, accent, ...handlers }: { label: string; accent?: boolean } & Record<string, unknown>) {
  return (
    <button
      {...handlers}
      className={`size-11 rounded-lg border text-[9px] font-black shadow-lg sm:size-12 ${accent ? 'border-emerald-300/40 bg-emerald-500/90 text-slate-950' : 'border-white/15 bg-black/70 text-white'}`}
    >
      {label}
    </button>
  );
}

function ActionButton({ label, color, onPress, small, dark }: {
  label: string; color: string; onPress: () => void; small?: boolean; dark?: boolean;
}) {
  return (
    <button
      onPointerDown={(e) => { e.preventDefault(); onPress(); }}
      className={`${color} ${small ? 'size-12 text-[8px]' : 'size-14 text-[10px]'} ${dark ? 'text-slate-950' : 'text-white'} rounded-full border border-white/25 font-black shadow-lg active:scale-95`}
    >
      {label}
    </button>
  );
}


