import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveVariant, scheduleVariants, recorridoGroupKey } from '../lib/synth.js';

function group(day = 1, { count = 4, gap = 30, duration = 12, hour = 11, periodo = 'AM', tipo = 'Privado', calzada = 'Única' } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const startTs = new Date(2026, 9, day, hour, i * gap).getTime();
    const endTs = startTs + duration * 60000;
    return {
      id: `synthetic-${periodo}-${tipo}-${calzada}-${i}`,
      name: `*Recorrido ${i + 1}`,
      synthetic: true, periodo, tipo, calzada, startTs, endTs,
      points: [
        { lat: 4.6, lng: -74.08, timestamp: startTs, speed: 8 },
        { lat: 4.61, lng: -74.07, timestamp: endTs, speed: 9 },
      ],
    };
  });
}

function checkSchedule(source, result) {
  assert.equal(result.length, source.length);
  const groups = new Map();
  for (const rec of source) {
    const key = recorridoGroupKey(rec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  for (const originals of groups.values()) {
    originals.sort((a, b) => a.startTs - b.startTs);
    let previous = null;
    originals.forEach((original, i) => {
      const rec = result.find((r) => r.name === original.name && r.periodo === original.periodo && r.tipo === original.tipo && r.calzada === original.calzada);
      assert.ok(rec);
      const shift = rec.startTs - original.startTs;
      assert.ok(i === 0 ? shift >= 180000 && shift <= 240000 : Math.abs(shift) <= 300000);
      assert.equal(rec.endTs - rec.startTs, original.endTs - original.startTs);
      assert.ok(rec.endTs <= Math.max(originals[0].startTs + 3 * 3600000, ...originals.map((r) => r.endTs)));
      assert.equal(rec.synthetic, true);
      assert.notEqual(rec.id, original.id);
      rec.points.forEach((p, j) => assert.deepEqual(p, { ...original.points[j], timestamp: original.points[j].timestamp + shift }));
      if (previous) assert.ok(rec.startTs >= previous.endTs + 30000);
      previous = rec;
    });
  }
}

test('first start is 3–4 minutes later; following starts vary independently within five minutes', () => {
  let earlier = 0, later = 0;
  for (let day = 1; day <= 200; day++) {
    const source = group(day);
    const snapshot = structuredClone(source);
    const result = scheduleVariants(source);
    checkSchedule(source, result);
    assert.deepEqual(source, snapshot);
    assert.deepEqual(scheduleVariants(source), result);
    const shifts = result.map((rec, i) => rec.startTs - source[i].startTs);
    assert.ok(new Set(shifts).size > 1);
    earlier += shifts.slice(1).filter((n) => n < 0).length;
    later += shifts.slice(1).filter((n) => n > 0).length;
  }
  assert.ok(earlier > 0 && later > 0);
});

test('six-minute historical intervals do not become a fixed delayed copy', () => {
  for (let day = 1; day <= 100; day++) {
    const source = group(day, { gap: 6, duration: 5 });
    const result = scheduleVariants(source);
    checkSchedule(source, result);
    const intervals = result.slice(1).map((rec, i) => rec.startTs - result[i].startTs);
    assert.ok(intervals.some((n) => n !== 360000));
    assert.ok(new Set(intervals).size > 1);
  }
});

test('AM, PM and different vehicle groups are scheduled independently', () => {
  const source = [...group(), ...group(1, { hour: 16, periodo: 'PM' }), ...group(1, { tipo: 'Moto' })];
  checkSchedule(source, scheduleVariants(source));
});

test('impossible schedules fail instead of exceeding the shift or overlapping', () => {
  const source = group(1, { count: 12, gap: 6, duration: 5.9 });
  const snapshot = structuredClone(source);
  assert.throws(() => scheduleVariants(source), /no admiten ese desfase/);
  assert.deepEqual(source, snapshot);
});

test('invalid durations and margins fail clearly; an empty list remains empty', () => {
  assert.deepEqual(scheduleVariants([]), []);
  assert.throws(() => scheduleVariants(group(), { startShiftSec: -1 }), /márgenes/);
  const source = group();
  source[0].endTs = source[0].startTs;
  assert.throws(() => scheduleVariants(source), /duración válida/);
});

test('rescheduling a generated variant preserves the existing speed and geometry variation', () => {
  const reference = group()[0];
  const derived = deriveVariant(reference, { date: '2026-10-28', startShiftSec: 0 });
  const rec = { ...reference, id: derived.meta.localId, points: derived.points, startTs: derived.startTs, endTs: derived.endTs };
  checkSchedule([rec], scheduleVariants([rec]));
});
