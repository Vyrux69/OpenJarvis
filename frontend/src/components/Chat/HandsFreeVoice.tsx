import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../lib/store';
import { stripThinkTags, toSpeakableText } from '../../lib/message-text';

/**
 * Hands-free voice mode that uses the browser's own Web Speech API.
 * Nothing here talks to the OpenJarvis speech backend. Flow, one turn at a time:
 * listen -> send as a normal chat message -> wait for the reply -> read it aloud
 * -> listen again. It never listens while speaking, starts only when the user
 * taps Start, and stops on Stop, on errors, on silence, when the tab is hidden,
 * or after MAX_TURNS turns.
 * The server reports failures as ordinary assistant text ("Sorry, an error
 * occurred: ..."). Those replies are not read aloud; the cycle pauses with a
 * short spoken notice instead, and the user restarts manually.
 * Note: in Chrome the recognition audio is sent by the browser to Google.
 */

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

const MAX_TURNS = 20;
const MAX_SILENT = 2;
const LANG = 'es-MX';
// Visible build id, so it is clear which version of the page is loaded.
const VOICE_BUILD = 'voz-v5';

// The backend turns request failures into normal assistant messages with one
// of these prefixes (stream_bridge.py / routes.py). Detection uses the raw
// store text, so browser page translation does not affect it.
type ErrorReplyKind = 'saturation' | 'too-long' | 'service';

function classifyErrorReply(text: string): ErrorReplyKind | null {
  if (text.startsWith('The input is too long')) return 'too-long';
  if (text.startsWith('Sorry, an error occurred:') || text.startsWith('The model returned an error:')) {
    return /\b503\b|UNAVAILABLE|high demand/i.test(text) ? 'saturation' : 'service';
  }
  return null;
}

function getRecognitionCtor(): any {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  const es = voices.filter((v) => v.lang?.toLowerCase().startsWith('es'));
  const exact = es.filter((v) => v.lang.toLowerCase().replace('_', '-') === LANG.toLowerCase());
  const pool = exact.length ? exact : es;
  return pool.find((v) => v.localService) ?? pool[0] ?? null;
}

export function HandsFreeVoice() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<string>('');
  const [heard, setHeard] = useState<string>('');
  const activeRef = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  const recRef = useRef<any>(null);
  const turnsRef = useRef(0);
  const silentRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);

  const supported = typeof window !== 'undefined'
    && !!getRecognitionCtor()
    && 'speechSynthesis' in window;

  const setP = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  };
  const later = (fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  };

  const stop = useCallback((message = '') => {
    activeRef.current = false;
    clearTimers();
    unsubRef.current?.();
    unsubRef.current = null;
    try { recRef.current?.abort?.(); } catch { /* ignore */ }
    recRef.current = null;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setP('idle');
    setNote(message);
  }, []);

  // Stop the cycle and speak a short notice. Capture stops BEFORE the notice,
  // the notice's onend never re-arms listening, and Detener still cancels it
  // because the phase stays 'speaking' (non-idle) until it finishes.
  const speakNoticeAndStop = useCallback((spoken: string, noteText: string) => {
    activeRef.current = false;
    clearTimers();
    unsubRef.current?.();
    unsubRef.current = null;
    try { recRef.current?.abort?.(); } catch { /* ignore */ }
    recRef.current = null;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setNote(noteText);
    try {
      const u = new SpeechSynthesisUtterance(spoken);
      u.lang = LANG;
      const v = pickVoice();
      if (v) u.voice = v;
      setP('speaking');
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (!activeRef.current) setP('idle');
      };
      u.onend = finish;
      u.onerror = finish;
      later(finish, Math.min(30000, 4000 + spoken.length * 90));
      window.speechSynthesis.speak(u);
    } catch {
      setP('idle');
    }
  }, []);

  const speakThenListen = useCallback((text: string) => {
    if (!activeRef.current) return;
    const spoken = toSpeakableText(text);
    if (!spoken) { listenRef.current(); return; }
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    const u = new SpeechSynthesisUtterance(spoken);
    u.lang = LANG;
    const v = pickVoice();
    if (v) u.voice = v;
    setP('speaking');
    setNote(v ? `Leyendo con voz: ${v.name}${v.localService ? '' : ' (remota)'}` : 'Leyendo con la voz predeterminada del teléfono');
    let done = false;
    const next = () => {
      if (done) return;
      done = true;
      if (!activeRef.current) return;
      later(() => { if (activeRef.current) listenRef.current(); }, 700);
    };
    u.onend = next;
    u.onerror = next;
    // Some Android browsers never fire onend: fall back to a length-based timer.
    later(next, Math.min(120000, 8000 + spoken.length * 90));
    window.speechSynthesis.speak(u);
  }, []);

  const waitForReply = useCallback(() => {
    setP('thinking');
    setNote('Esperando respuesta...');
    let started = false;
    unsubRef.current?.();
    const unsub = useAppStore.subscribe((s) => {
      if (!activeRef.current) return;
      if (s.streamState.isStreaming) { started = true; return; }
      if (!started) return;
      unsub();
      unsubRef.current = null;
      const last = s.messages[s.messages.length - 1];
      if (!last || last.role !== 'assistant') { stop('No llegó respuesta. Modo voz detenido.'); return; }
      const text = stripThinkTags(last.content);
      if (!text) { stop('Respuesta vacía. Modo voz detenido.'); return; }
      const errKind = classifyErrorReply(text);
      if (errKind === 'saturation') {
        speakNoticeAndStop(
          'El servicio está saturado. Pausé el modo voz. Toca iniciar modo voz para reintentar en unos minutos.',
          'Servicio saturado (503). Modo voz en pausa.',
        );
        return;
      }
      if (errKind === 'too-long') {
        speakNoticeAndStop(
          'El mensaje es demasiado largo para el modelo. Modo voz detenido.',
          'Entrada demasiado larga. Modo voz detenido.',
        );
        return;
      }
      if (errKind === 'service') {
        speakNoticeAndStop(
          'El servicio tuvo un error. Pausé el modo voz. Toca iniciar modo voz para reintentar.',
          'Error del servicio. Modo voz en pausa.',
        );
        return;
      }
      speakThenListen(text);
    });
    unsubRef.current = unsub;
    later(() => {
      if (activeRef.current && !started) stop('No se pudo enviar el mensaje. Modo voz detenido.');
    }, 8000);
  }, [speakNoticeAndStop, speakThenListen, stop]);

  const submitText = useCallback((text: string) => {
    // Do not rely on English labels: browser page translation rewrites them.
    const ta = (document.querySelector('textarea[placeholder^="Message OpenJarvis"]')
      || document.querySelector('textarea')) as HTMLTextAreaElement | null;
    if (!ta) { stop('No encontré el cuadro de mensaje.'); return; }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    // React updates asynchronously, and slow phones can take well over 150 ms to
    // enable the send button. Re-apply the text and poll for an enabled button.
    let tries = 0;
    const attempt = () => {
      if (!activeRef.current) return;
      tries += 1;
      if (ta.value !== text) {
        setter?.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // The send button is the last button next to the textarea (after the mic button).
      const row = ta.parentElement;
      const buttons = row ? Array.from(row.querySelectorAll('button')) : [];
      const btn = (buttons[buttons.length - 1] as HTMLButtonElement | undefined) ?? null;
      if (btn && !btn.disabled && ta.value === text) {
        waitForReply();
        btn.click();
        return;
      }
      if (tries >= 30) {
        stop(btn
          ? 'El botón de enviar siguió desactivado (¿modelo cargando o respuesta en curso?). Modo voz detenido.'
          : 'No encontré el botón de enviar. Modo voz detenido.');
        return;
      }
      later(attempt, 100);
    };
    later(attempt, 100);
  }, [stop, waitForReply]);

  const listen = useCallback(() => {
    if (!activeRef.current) return;
    if (turnsRef.current >= MAX_TURNS) { stop('Límite de turnos alcanzado. Modo voz detenido.'); return; }
    if (useAppStore.getState().streamState.isStreaming) { later(() => listenRef.current(), 500); return; }
    const Ctor = getRecognitionCtor();
    if (!Ctor) { stop('Este navegador no tiene reconocimiento de voz.'); return; }
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = LANG;
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let gotResult = false;
    let failed = false;
    rec.onresult = (e: any) => {
      const t = (e.results?.[0]?.[0]?.transcript ?? '').trim();
      if (!t) return;
      gotResult = true;
      silentRef.current = 0;
      turnsRef.current += 1;
      setHeard(t);
      submitText(t);
    };
    rec.onerror = (e: any) => {
      const err = e?.error;
      if (err === 'no-speech' || err === 'aborted') return; // handled in onend
      failed = true;
      if (err === 'not-allowed' || err === 'service-not-allowed') stop('Permiso de micrófono denegado. Actívalo en el navegador.');
      else if (err === 'network') stop('El reconocimiento de voz del navegador no pudo conectarse.');
      else stop(`Error de voz: ${err ?? 'desconocido'}.`);
    };
    rec.onend = () => {
      if (!activeRef.current || gotResult || failed) return;
      silentRef.current += 1;
      if (silentRef.current >= MAX_SILENT) { stop('No te escuché. Modo voz detenido.'); return; }
      later(() => listenRef.current(), 400);
    };
    try {
      rec.start();
      setP('listening');
      setNote('Te escucho... habla ahora.');
    } catch {
      stop('No se pudo iniciar el micrófono.');
    }
  }, [stop, submitText]);

  const listenRef = useRef(listen);
  listenRef.current = listen;

  const start = () => {
    if (activeRef.current) return;
    if (!useAppStore.getState().selectedModel) { setNote('Primero elige un modelo.'); return; }
    activeRef.current = true;
    turnsRef.current = 0;
    silentRef.current = 0;
    setHeard('');
    // Prime speech synthesis inside the tap so browsers allow later playback.
    try {
      const prime = new SpeechSynthesisUtterance(' ');
      prime.volume = 0;
      window.speechSynthesis.speak(prime);
    } catch { /* ignore */ }
    listen();
  };

  useEffect(() => {
    const onHide = () => { if (document.hidden && activeRef.current) stop('Modo voz detenido al salir de la pantalla.'); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      stop();
    };
  }, [stop]);

  if (!supported) return null;

  const active = phase !== 'idle';
  const label: Record<Phase, string> = {
    idle: 'Modo voz',
    listening: 'Escuchando',
    thinking: 'Pensando',
    speaking: 'Hablando',
  };

  return (
    <div className="px-4 pb-1" style={{ color: 'var(--color-text-secondary)' }}>
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => (active ? stop('Modo voz detenido.') : start())}
          className="px-3 py-1.5 rounded-full cursor-pointer"
          style={{
            background: active ? 'var(--color-error)' : 'var(--color-bg-tertiary)',
            color: active ? 'white' : 'var(--color-text)',
          }}
          title={active ? 'Detener modo voz' : 'Iniciar modo voz manos libres'}
        >
          {active ? `■ Detener · ${label[phase]}` : '🎙 Iniciar modo voz'}
        </button>
        <span className="truncate">{note}</span>
      </div>
      {active && heard && (
        <div className="text-[11px] mt-1 truncate">Escuché: {heard}</div>
      )}
      {!active && (
        <div className="text-[11px] mt-1" style={{ color: 'var(--color-text-tertiary)' }}>
          Usa el micrófono del navegador (en Chrome el audio lo procesa Google). Versión: {VOICE_BUILD}
        </div>
      )}
    </div>
  );
}
