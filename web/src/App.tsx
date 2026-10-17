import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getArenaClient, type ArenaClient } from "./client";
import { Board } from "./components/Board";
import { BrandMark } from "./components/BrandMark";
import { type AnalysisState } from "./components/AnalysisPanel";
import { CallDetail } from "./components/CallDetail";
import { CompareTable } from "./components/CompareTable";
import { DecisionFlow } from "./components/DecisionFlow";
import { HistoryTable } from "./components/HistoryTable";
import { ModeBadge } from "./components/ModeBadge";
import { ParticipantBlock } from "./components/ParticipantBlock";
import { ResultScreen } from "./components/ResultScreen";
import { parsePlacement, uciSquares } from "./fen";
import { formatDuration, summarizeDurations } from "./format";
import { allOptions, optionValue, quickMatchups, reconcileParticipants, type Matchup } from "./matchups";
import type { ArenaMode, ParticipantConfig, ProviderInfo, ScenarioId, SessionSnapshot, Slot } from "./types";
import {
  SCENARIOS,
  costNote,
  displayMove,
  entryProvider,
  failureNote,
  lastAppliedChoice,
  latestFor,
  modelLabel,
  scenarioLabel,
  victoryLine,
} from "./view";

type View = "arena" | "result";
type DecideStatus = "applied" | "failed" | "stale" | "http";

function message(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Falha de ligação.";
}

function showArena(setView: (view: View) => void) {
  setView("arena");
  if (window.location.hash) {
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
  }
}

function showResult(setView: (view: View) => void) {
  setView("result");
  if (window.location.hash !== "#resultado") window.location.hash = "resultado";
}

export function App() {
  const [attempt, setAttempt] = useState(0);
  const [client, setClient] = useState<ArenaClient | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: "idle" });
  const [mode, setMode] = useState<ArenaMode>("battle");
  const [scenarioId, setScenarioId] = useState<ScenarioId>("game");
  const [participants, setParticipants] = useState<ParticipantConfig[]>([
    { slot: 0, provider: "demo", modelId: "" },
    { slot: 1, provider: "demo", modelId: "" },
  ]);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [waitNote, setWaitNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySlot, setBusySlot] = useState<Slot | null>(null);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<View>("arena");
  const [showDetail, setShowDetail] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [visibleSlot, setVisibleSlot] = useState<Slot | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [manualStop, setManualStop] = useState(false);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const epochRef = useRef(0);
  const actionSeq = useRef(0);
  const sessionRef = useRef<SessionSnapshot | null>(null);
  const participantsRef = useRef(participants);
  const clientRef = useRef<ArenaClient | null>(null);
  const runMode = useRef<"idle" | "auto">("idle");
  const loopLock = useRef(false);
  const compareLock = useRef(false);
  participantsRef.current = participants;
  sessionRef.current = session;
  clientRef.current = client;

  const api = (): ArenaClient => {
    if (!clientRef.current) throw new ApiError("Sem ligação com a arena.", 0);
    return clientRef.current;
  };

  const options = useMemo(() => (providers ? allOptions(providers) : []), [providers]);
  const matchups = useMemo(() => (providers ? quickMatchups(providers) : []), [providers]);

  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of options) map.set(`${option.provider}:${option.id}`, option.label);
    for (const option of options) if (!map.has(option.id)) map.set(option.id, option.label);
    return map;
  }, [options]);

  useEffect(() => {
    if (busySlot == null) {
      setCallStartedAt(null);
      return;
    }
    const started = Date.now();
    setCallStartedAt(started);
    setNow(started);
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [busySlot]);

  useEffect(() => {
    const sync = () => setView(window.location.hash === "#resultado" ? "result" : "arena");
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    let alive = true;
    setModelsError(null);
    getArenaClient()
      .then(async (chosen) => {
        const data = await chosen.providers();
        return { chosen, data };
      })
      .then(({ chosen, data }) => {
        if (!alive) return;
        setClient(chosen);
        setProviders(data.providers);
        setParticipants((current) => reconcileParticipants(current, data.providers));
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setProviders(null);
        setModelsError(message(error));
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  useEffect(() => {
    const left = participants[0];
    const right = participants[1];
    epochRef.current += 1;
    actionSeq.current += 1;
    runMode.current = "idle";
    setRunning(false);
    setManualStop(false);
    setWaitNote(null);
    setActionError(null);
    setVisibleSlot(null);
    setSelectedIndex(null);
    if (!client || !providers || !left?.modelId || !right?.modelId) {
      sessionRef.current = null;
      setSession(null);
      setSessionLoading(false);
      setSessionError(null);
      return;
    }
    const epoch = epochRef.current;
    let alive = true;
    sessionRef.current = null;
    setSession(null);
    setSessionError(null);
    setSessionLoading(true);
    showArena(setView);
    client
      .createSession({ mode, scenarioId, participants: [left, right] })
      .then((snap) => {
        if (!alive || epochRef.current !== epoch) return;
        sessionRef.current = snap;
        setSession(snap);
        setSessionLoading(false);
        if (snap.mode === "battle" && snap.outcome) showResult(setView);
      })
      .catch((error: unknown) => {
        if (!alive || epochRef.current !== epoch) return;
        sessionRef.current = null;
        setSession(null);
        setSessionError(message(error));
        setSessionLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [client, providers, mode, scenarioId, participants]);

  const analysisKey = `${session?.sessionId ?? ""}:${session?.history.length ?? 0}:${session?.outcome?.kind ?? ""}`;
  useEffect(() => {
    const current = sessionRef.current;
    if (view !== "result" || !client || !current || current.mode !== "battle" || current.history.length === 0) {
      setAnalysis({ status: "idle" });
      return;
    }
    let alive = true;
    setAnalysis({ status: "loading" });
    client
      .analysis(current.sessionId)
      .then((data) => {
        if (alive) setAnalysis({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (alive) setAnalysis({ status: "error", message: message(error) });
      });
    return () => {
      alive = false;
    };
  }, [view, client, analysisKey]);

  async function runDecide(slot: Slot): Promise<DecideStatus> {
    const current = sessionRef.current;
    if (!current) return "failed";
    const sessionId = current.sessionId;
    const epoch = epochRef.current;
    const seq = actionSeq.current;
    const provider = participantsRef.current.find((item) => item.slot === slot)?.provider ?? "demo";
    setBusySlot(slot);
    setWaitNote(null);
    const timer = provider === "cursor"
      ? 0
      : window.setTimeout(() => {
          if (epochRef.current !== epoch || actionSeq.current !== seq) return;
          if (sessionRef.current?.sessionId !== sessionId) return;
          setWaitNote("Tempo esgotado na espera. Outra sessão não recebe essa resposta.");
        }, 30_000);
    try {
      if (sessionRef.current?.status === "paused") {
        const resumed = await api().action(sessionId, "resume");
        if (epochRef.current !== epoch || actionSeq.current !== seq) return "stale";
        if (sessionRef.current?.sessionId !== sessionId || resumed.sessionId !== sessionId) return "stale";
        sessionRef.current = resumed;
        setSession(resumed);
      }
      const parsed = await api().decide(sessionId, slot);
      if (epochRef.current !== epoch || actionSeq.current !== seq) return "stale";
      if (sessionRef.current?.sessionId !== sessionId) return "stale";
      if (parsed.stale) return "stale";
      sessionRef.current = parsed.session;
      setSession(parsed.session);
      setWaitNote(null);
      if (parsed.decision) {
        setVisibleSlot(parsed.decision.slot);
        setSelectedIndex(Math.max(0, parsed.session.history.length - 1));
      }
      const accepted = parsed.decision?.validation === "aceita";
      const outcome = parsed.session.outcome;
      const ended = parsed.session.mode === "battle" && outcome && (accepted || outcome.kind !== "stopped");
      if (ended) showResult(setView);
      if (!accepted) {
        if (!parsed.decision && !parsed.session.outcome) setActionError(parsed.reason ?? "Decisão bloqueada.");
        return "failed";
      }
      return "applied";
    } catch (error) {
      if (epochRef.current !== epoch || actionSeq.current !== seq) return "stale";
      if (sessionRef.current?.sessionId !== sessionId) return "stale";
      setActionError(message(error));
      return "http";
    } finally {
      window.clearTimeout(timer);
      setBusySlot(null);
    }
  }

  async function compare() {
    if (compareLock.current || loopLock.current || busy) return;
    compareLock.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const first = await runDecide(0);
      if (first === "stale") return;
      await runDecide(1);
    } finally {
      compareLock.current = false;
      setBusy(false);
    }
  }

  async function battleLoop() {
    if (loopLock.current) {
      runMode.current = "auto";
      setRunning(true);
      return;
    }
    const snap = sessionRef.current;
    if (!snap || snap.outcome || snap.candidates.length === 0) return;
    loopLock.current = true;
    runMode.current = "auto";
    setRunning(true);
    setBusy(true);
    try {
      while (runMode.current === "auto") {
        const current = sessionRef.current;
        if (!current || current.outcome || current.candidates.length === 0 || current.status === "failed") {
          runMode.current = "idle";
          if (current?.outcome) showResult(setView);
          break;
        }
        const slot: Slot = current.sideToMove === "b" ? 1 : 0;
        const result = await runDecide(slot);
        if (result === "stale") return;
        if (result !== "applied" || sessionRef.current?.outcome) {
          runMode.current = "idle";
          break;
        }
      }
    } finally {
      loopLock.current = false;
      setBusy(false);
      setRunning(runMode.current === "auto");
      if (runMode.current !== "auto") runMode.current = "idle";
    }
  }

  async function nextMove() {
    if (loopLock.current || compareLock.current || busy || running) return;
    const snap = sessionRef.current;
    if (!snap || snap.outcome || snap.candidates.length === 0) return;
    setBusy(true);
    try {
      await runDecide(snap.sideToMove === "b" ? 1 : 0);
    } finally {
      setBusy(false);
    }
  }

  async function pause() {
    runMode.current = "idle";
    setRunning(false);
    const id = sessionRef.current?.sessionId;
    const epoch = epochRef.current;
    const seq = actionSeq.current;
    if (!id) return;
    try {
      const snap = await api().action(id, "pause");
      if (epochRef.current !== epoch || actionSeq.current !== seq) return;
      if (sessionRef.current?.sessionId !== id || snap.sessionId !== id) return;
      setSession((prev) => {
        if (!prev || prev.sessionId !== snap.sessionId) return prev;
        if (snap.history.length < prev.history.length) return prev;
        sessionRef.current = snap;
        return snap;
      });
    } catch (error) {
      if (epochRef.current === epoch && actionSeq.current === seq && sessionRef.current?.sessionId === id) {
        setActionError(message(error));
      }
    }
  }

  async function stop() {
    runMode.current = "idle";
    setRunning(false);
    actionSeq.current += 1;
    const id = sessionRef.current?.sessionId;
    const epoch = epochRef.current;
    if (!id) return;
    setBusy(true);
    try {
      const snap = await api().action(id, "stop");
      if (epochRef.current !== epoch || sessionRef.current?.sessionId !== id && snap.sessionId !== id) return;
      if (snap.sessionId !== id) return;
      sessionRef.current = snap;
      setSession(snap);
      setManualStop(!snap.outcome);
      showResult(setView);
    } catch (error) {
      if (epochRef.current === epoch) setActionError(message(error));
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    runMode.current = "idle";
    setRunning(false);
    actionSeq.current += 1;
    const id = sessionRef.current?.sessionId;
    const epoch = epochRef.current;
    if (!id) return;
    setBusy(true);
    try {
      const snap = await api().action(id, "restart");
      if (epochRef.current !== epoch) return;
      sessionRef.current = snap;
      setSession(snap);
      setManualStop(false);
      setVisibleSlot(null);
      setSelectedIndex(null);
      setWaitNote(null);
      setActionError(null);
      showArena(setView);
    } catch (error) {
      if (epochRef.current === epoch) setActionError(message(error));
    } finally {
      setBusy(false);
    }
  }

  async function onExport() {
    const id = sessionRef.current?.sessionId;
    if (!id) return;
    try {
      const data = await api().exportSession(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `chess-arena-${id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setActionError(message(error));
    }
  }

  function pickModel(slot: Slot, value: string) {
    const option = options.find((item) => optionValue(item) === value);
    setParticipants((current) =>
      current.map((participant) =>
        participant.slot === slot
          ? {
              slot,
              provider: option?.provider ?? "demo",
              modelId: option?.id ?? "",
            }
          : participant,
      ),
    );
  }

  function applyMatchup(matchup: Matchup) {
    setParticipants(matchup.participants);
  }

  const clockFor = (slot: Slot): number | null => {
    const remaining = session?.clock?.remainingMs[slot];
    if (remaining == null) return null;
    return busySlot === slot && callStartedAt != null ? remaining - (now - callStartedAt) : remaining;
  };
  const bothModels = Boolean(participants[0]?.modelId && participants[1]?.modelId);
  const noMoves = Boolean(session && session.candidates.length === 0);
  const finished = Boolean(session?.outcome || manualStop);
  const primaryLabel = mode === "compare" ? "Comparar" : running ? "Pausar" : scenarioId === "game" ? "Jogar" : "Iniciar";
  const primaryDisabled =
    !providers ||
    Boolean(modelsError) ||
    !bothModels ||
    !session ||
    sessionLoading ||
    (mode === "compare" && busy) ||
    (mode === "battle" && !running && (busy || finished || noMoves || session?.status === "failed"));

  const focusEntry =
    selectedIndex != null && session?.history[selectedIndex]
      ? session.history[selectedIndex]
      : visibleSlot != null
        ? latestFor(session?.history ?? [], visibleSlot)
        : (session?.history.at(-1) ?? null);

  const marked =
    mode === "compare"
      ? uciSquares(focusEntry?.choiceId)
      : uciSquares(lastAppliedChoice(session?.history ?? []));
  const fenOk = session ? parsePlacement(session.fen) !== null : false;
  const linkError = modelsError ?? sessionError;

  let statusLine: string;
  if (linkError) statusLine = "Falha de ligação.";
  else if (!bothModels) statusLine = "Escolha os dois modelos.";
  else if (sessionLoading) statusLine = "Abrindo sessão.";
  else if (busySlot != null) statusLine = `Consultando o participante ${busySlot + 1}.`;
  else if (waitNote) statusLine = waitNote;
  else if (mode === "compare") statusLine = session ? "Pronta para comparar." : "Aguardando a sessão.";
  else if (running) statusLine = scenarioId === "game" ? "Partida em andamento. Segue até o mate, o empate ou o fim do relógio." : "Disputa em andamento.";
  else if (finished) statusLine = (session?.outcome ? victoryLine(session.outcome, participants, labelById) : null) ?? session?.outcome?.label ?? "Interrompida · sem vencedor";
  else if (noMoves) statusLine = "Sem lance legal. Nenhuma chamada.";
  else if (session && session.history.length > 0) statusLine = "Disputa pausada.";
  else statusLine = scenarioId === "game" ? "Partida pronta. 5 minutos por lado. Segue até o mate, o empate ou o fim do relógio." : "Pronta para a disputa.";

  const failureEntries = (session?.history ?? []).filter(
    (entry) => entry.validation === "falha" || entry.validation === "recusada",
  );

  const participantBlock = (slot: Slot) => (
    <ParticipantBlock
      key={slot}
      slot={slot}
      battle={mode === "battle"}
      model={modelLabel(participants[slot]?.modelId ?? "", labelById)}
      session={session}
      entry={latestFor(session?.history ?? [], slot)}
      participants={participants}
      active={mode === "compare" ? visibleSlot === slot : session?.sideToMove === (slot === 1 ? "b" : "w")}
      consulting={busySlot === slot}
      clockMs={clockFor(slot)}
      compact
      onSelect={() => {
        setVisibleSlot(slot);
        const history = session?.history ?? [];
        for (let index = history.length - 1; index >= 0; index -= 1) {
          if (history[index]?.slot === slot) {
            setSelectedIndex(index);
            return;
          }
        }
        setSelectedIndex(null);
      }}
    />
  );

  return (
    <div className="app">
      <header className="masthead">
        <BrandMark />
        {client ? <ModeBadge mode={client.mode} /> : null}
      </header>
      <main className="main">
        {view === "result" ? (
          <ResultScreen
            session={session}
            participants={participants}
            analysis={analysis}
            labels={labelById}
            manualStop={manualStop}
            busy={busy}
            onBack={() => showArena(setView)}
            onRestart={() => void restart()}
            onExport={() => void onExport()}
          />
        ) : (
          <>
            <section className="console" aria-label="Controles da arena">
              <div className="console-row">
                <div className="chips" role="group" aria-label="Cenário">
                  {SCENARIOS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={scenarioId === item.id ? "chip on" : "chip"}
                      aria-pressed={scenarioId === item.id}
                      onClick={() => setScenarioId(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="chips seg" role="group" aria-label="Modo">
                  <button type="button" className={mode === "compare" ? "chip on" : "chip"} aria-pressed={mode === "compare"} onClick={() => setMode("compare")}>
                    Comparação
                  </button>
                  <button type="button" className={mode === "battle" ? "chip on" : "chip"} aria-pressed={mode === "battle"} onClick={() => setMode("battle")}>
                    Disputa
                  </button>
                </div>
              </div>
              <div className="console-row console-row-main">
                <div className="models">
                  {([0, 1] as Slot[]).map((slot) => {
                    const participant = participants[slot];
                    const value = participant?.modelId ? `${participant.provider}:${participant.modelId}` : "";
                    const label = mode === "battle" ? (slot === 0 ? "Brancas" : "Pretas") : slot === 0 ? "Modelo 1" : "Modelo 2";
                    return (
                      <label key={slot} className={`field ${mode === "battle" ? (slot === 0 ? "field-w" : "field-b") : ""}`}>
                        <span>{label}</span>
                        <select value={value} onChange={(event) => pickModel(slot, event.target.value)} disabled={!providers}>
                          <option value="">Escolha o modelo</option>
                          {(providers ?? []).map((provider) => (
                            <optgroup
                              key={provider.id}
                              label={provider.available ? provider.label : `${provider.label} · indisponível`}
                            >
                              {provider.available && provider.models.length > 0 ? (
                                provider.models.map((model) => (
                                  <option key={model.id} value={optionValue({ provider: provider.id, id: model.id })}>
                                    {model.label}
                                  </option>
                                ))
                              ) : (
                                <option disabled value={`${provider.id}:`}>
                                  {provider.available ? "Sem modelos" : `Indisponível: ${provider.reason ?? "motivo desconhecido"}`}
                                </option>
                              )}
                            </optgroup>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={primaryDisabled}
                    aria-busy={busy || sessionLoading}
                    onClick={() => {
                      if (mode === "compare") void compare();
                      else if (running) void pause();
                      else void battleLoop();
                    }}
                  >
                    {primaryLabel}
                  </button>
                  {mode === "battle" ? (
                    <button type="button" className="btn btn-secondary" disabled={!session || sessionLoading} onClick={() => void stop()}>
                      Parar
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-secondary" disabled={!session || sessionLoading} onClick={() => void restart()}>
                    Reiniciar
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-pressed={showDetail}
                    onClick={() => setShowDetail((value) => !value)}
                  >
                    {showDetail ? "Ocultar detalhe" : "Detalhe"}
                  </button>
                </div>
              </div>
            </section>

            <div className={`status-row${busySlot != null || running ? " live" : ""}`}>
              <p className="status" role="status">
                <span className="status-dot" aria-hidden="true" />
                {statusLine}
              </p>
              {linkError ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAttempt((value) => value + 1)}>
                  Tentar de novo
                </button>
              ) : null}
            </div>

            <div className="versus">
              <div className="versus-w">{participantBlock(0)}</div>
              <section className="board-panel">
                <div className="board-meta">
                  <p className="mono scenario-name">{session ? scenarioLabel(session.scenarioId) : "Sem posição"}</p>
                  <p className="turn-line">
                    {session ? (session.sideToMove === "b" ? "Pretas jogam" : "Brancas jogam") : "Aguardando a sessão."}
                  </p>
                  {session?.inCheck ? <p className="check-flag">Xeque.</p> : null}
                </div>
                <Board fen={fenOk ? session?.fen ?? null : null} flipped={flipped} from={marked?.from ?? null} to={marked?.to ?? null} />
                {session && !fenOk ? <p className="note fail"><span className="note-label">Falha</span>FEN ilegível.</p> : null}
                {!session ? <p className="hint">Sem posição. Aguardando a sessão.</p> : null}
              </section>
              <div className="versus-b">{participantBlock(1)}</div>
            </div>

            {showDetail ? (
            <>
            <div className="detail-tools">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFlipped((value) => !value)}>
                Inverter
              </button>
              {mode === "battle" ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!session || sessionLoading || busy || running || finished || noMoves || session.status === "failed"}
                  onClick={() => void nextMove()}
                >
                  Próxima jogada
                </button>
              ) : null}
              <button type="button" className="btn btn-secondary btn-sm" disabled={!session} onClick={() => void onExport()}>
                Exportar
              </button>
              {session && (mode === "compare" ? session.history.length > 0 : Boolean(session.outcome || manualStop)) ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => showResult(setView)}>
                  Ver resultado
                </button>
              ) : null}
            </div>
            {matchups.length > 0 ? (
              <div className="detail-tools" role="group" aria-label="Confrontos rápidos">
                <span className="hint">Confrontos rápidos</span>
                {matchups.map((matchup) => (
                  <button
                    key={matchup.label}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => applyMatchup(matchup)}
                  >
                    {matchup.label}
                  </button>
                ))}
              </div>
            ) : null}
            <DecisionFlow
              objective={session?.objective ?? ""}
              sideLabel={
                !session
                  ? "Aguardando a sessão."
                  : session.mode === "compare"
                    ? session.sideToMove === "b"
                      ? "Os dois recebem as pretas."
                      : "Os dois recebem as brancas."
                    : session.sideToMove === "b"
                      ? "Pretas jogam."
                      : "Brancas jogam."
              }
              candidates={session?.candidates ?? []}
              choice={busySlot != null ? "Consultando." : displayMove(focusEntry, session)}
              validation={focusEntry?.validation ?? "idle"}
              waiting={busySlot != null}
            />

            <section className="totals">
              <article className="block">
                <h3>Soma das durações</h3>
                <p className="figure mono">{summarizeDurations((session?.history ?? []).map((entry) => entry.durationMs))}</p>
              </article>
              <article className="block">
                <h3>Relógio da sessão</h3>
                <p className="figure mono">{formatDuration(session?.sessionClockMs)}</p>
              </article>
            </section>

            {session && mode === "compare" ? (
              <CompareTable
                session={session}
                participants={participants}
                rows={([0, 1] as Slot[]).map((slot) => ({
                  slot,
                  entry: latestFor(session.history, slot),
                  modelName: modelLabel(participants[slot]?.modelId ?? "", labelById),
                }))}
                onSelect={(slot) => {
                  setVisibleSlot(slot);
                  const index = [...session.history].reverse().findIndex((entry) => entry.slot === slot);
                  setSelectedIndex(index === -1 ? null : session.history.length - 1 - index);
                }}
              />
            ) : null}

            <div className="lower">
              <HistoryTable
                entries={session?.history ?? []}
                session={session}
                participants={participants}
                selectedIndex={selectedIndex}
                onSelect={(index) => {
                  setSelectedIndex(index);
                  const entry = session?.history[index];
                  if (entry) setVisibleSlot(entry.slot);
                }}
              />
              <CallDetail
                entry={focusEntry}
                session={session}
                participants={participants}
                busyLabel={busySlot != null ? `Consultando o participante ${busySlot + 1}.` : null}
              />
            </div>

            </>
            ) : null}

            <div className="notes" aria-live="polite">
              {linkError ? (
                <p className="note fail">
                  <span className="note-label">Falha</span>
                  {linkError}
                </p>
              ) : null}
              {actionError ? (
                <p className="note fail">
                  <span className="note-label">Falha</span>
                  {actionError}
                </p>
              ) : null}
              {waitNote ? (
                <p className="note fail">
                  <span className="note-label">Tempo esgotado</span>
                  {waitNote}
                </p>
              ) : null}
              {failureEntries.map((entry, index) => (
                <p key={`${entry.slot}-${index}-${entry.failureReason ?? "falha"}`} className="note fail">
                  <span className="note-label">{entry.validation === "recusada" ? "Recusa" : "Falha"}</span>
                  {failureNote(entry)}
                </p>
              ))}
              {showDetail
                ? ([0, 1] as Slot[]).map((slot) => {
                    const entry = latestFor(session?.history ?? [], slot);
                    if (!entry) return null;
                    const note = costNote(entry, entryProvider(entry, participants));
                    if (!note) return null;
                    return (
                      <p key={`cost-${slot}`} className="note">
                        <span className="note-label">Custo</span>
                        {note}
                      </p>
                    );
                  })
                : null}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
