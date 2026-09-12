/**
 * Unit tests for UI audio synthesizer (lib/ui/sound.ts).
 * Exercises sound enable/disable preference, Web Audio synthesis,
 * pitch scaling (at parameter), and gap throttling.
 */
import './mockBrowser';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.com/',
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.localStorage = dom.window.localStorage;

const { isSoundEnabled, setSoundEnabled, playSound } = await import('../lib/ui/sound');

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

section('sound preference: enable/disable toggle');
{
  setSoundEnabled(true);
  assert(isSoundEnabled() === true, 'defaults to enabled');
  setSoundEnabled(false);
  assert(isSoundEnabled() === false, 'can be disabled');
  setSoundEnabled(true);
  assert(isSoundEnabled() === true, 'can be re-enabled');
}

section('audio synthesis: creates oscillators with frequency and pitch modulation');
{
  const createdNodes: { type: string; details: Record<string, unknown> }[] = [];
  let resumed: boolean = false;

  class MockAudioNode {
    connect(target: any) {
      return target;
    }
  }

  class MockGainNode extends MockAudioNode {
    gain = {
      setValueAtTime: (val: number, time: number) => {
        createdNodes.push({ type: 'gain-set', details: { val, time } });
      },
      exponentialRampToValueAtTime: (val: number, time: number) => {
        createdNodes.push({ type: 'gain-ramp', details: { val, time } });
      },
    };
  }

  class MockOscillatorNode extends MockAudioNode {
    type = 'sine';
    frequency = {
      value: 0,
      setValueAtTime(val: number, time: number) {
        this.value = val;
        createdNodes.push({ type: 'osc-freq', details: { val, time } });
      },
      exponentialRampToValueAtTime(val: number, time: number) {
        createdNodes.push({ type: 'osc-ramp', details: { val, time } });
      },
    };
    start(time: number) {
      createdNodes.push({ type: 'osc-start', details: { time } });
    }
    stop(time: number) {
      createdNodes.push({ type: 'osc-stop', details: { time } });
    }
  }

  class MockBiquadFilterNode extends MockAudioNode {
    type = 'lowpass';
    frequency = { value: 0 };
  }

  class MockAudioContext {
    currentTime = 0;
    state = 'suspended';
    destination = new MockAudioNode();
    createGain() {
      return new MockGainNode();
    }
    createOscillator() {
      return new MockOscillatorNode();
    }
    createBiquadFilter() {
      return new MockBiquadFilterNode();
    }
    async resume() {
      resumed = true;
      this.state = 'running';
    }
  }

  (globalThis as any).window.AudioContext = MockAudioContext;

  // Test click sound
  playSound('click');
  assert(Boolean(resumed), 'resumes suspended AudioContext on interaction');
  assert(
    createdNodes.some((n) => n.type === 'osc-freq' && Number(n.details.val) === 196),
    'click sound begins at 196Hz',
  );
  assert(
    createdNodes.some((n) => n.type === 'osc-ramp' && Number(n.details.val) === 130),
    'click sound ramps down to 130Hz',
  );

  // Test drag sound with pitch modulation (at = 1, highest pitch)
  createdNodes.length = 0;
  playSound('drag', { at: 1, gap: 0 });
  // Base drag is 174Hz, at pitchRatio = 1.5 (0.75 + 1 * 0.75 = 1.5), 174 * 1.5 = 261Hz
  assert(
    createdNodes.some((n) => n.type === 'osc-freq' && Math.round(Number(n.details.val)) === 261),
    'drag sound modulates pitch upward at high chart positions (at=1)',
  );

  // Test drag sound with lowest pitch (at = 0)
  createdNodes.length = 0;
  playSound('drag', { at: 0, gap: 0 });
  // Base drag is 174Hz, at pitchRatio = 0.75, 174 * 0.75 = 130.5Hz
  assert(
    createdNodes.some((n) => n.type === 'osc-freq' && Math.round(Number(n.details.val)) === 131),
    'drag sound modulates pitch downward at low chart positions (at=0)',
  );

  // Test gap throttling
  createdNodes.length = 0;
  playSound('drag', { at: 0.5, gap: 1000 });
  const countAfterFirst = createdNodes.length;
  assert(countAfterFirst > 0, 'first call plays sound');
  playSound('drag', { at: 0.5, gap: 1000 });
  assert(createdNodes.length === countAfterFirst, 'second call within gap is throttled');
}

console.log('\nAll sound tests finished.');
