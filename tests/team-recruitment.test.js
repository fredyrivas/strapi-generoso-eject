'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyAction, candidateDetails, newWorkflow } = require('../src/api/team-candidate/utils/workflow');
const { questionnaire, positions, weightedScore } = require('../src/api/team-candidate/utils/questionnaire');
const routes = require('../src/api/team-candidate/routes/team-candidate');

const fredy = { id: 1, name: 'Fredy' };
const norma = { id: 2, name: 'Norma' };
const now = '2026-11-09T17:00:00.000Z';

function process() {
  let candidate = { stage: 'new', status: 'new', score: 0, workflow: newWorkflow(fredy, now) };
  return {
    get candidate() { return candidate; },
    send(action, actor = fredy) { candidate = { ...candidate, ...applyAction(candidate, action, actor, now) }; },
  };
}

function answer(flow, step, questions) {
  for (const { key } of questions) flow.send({ action: 'answer', step, key, value: `Observación: ${key}` });
}

test('a draft resumes from the saved filter and gates the interview and competency assessment', () => {
  const flow = process();
  assert.throws(() => flow.send({ action: 'startInterview' }), /resultado Avanza/);
  flow.send({ action: 'startPhone' });
  flow.send({ action: 'answer', step: 'phone', key: 'motivation', value: 'Le interesa cocina.' });
  flow.send({ action: 'phoneOutcome', outcome: 'pending', reason: 'Confirmar disponibilidad' }, norma);
  assert.equal(flow.candidate.workflow.phone.answers.motivation, 'Le interesa cocina.');
  assert.equal(flow.candidate.workflow.phone.pending, 'Confirmar disponibilidad');
  assert.equal(flow.candidate.workflow.history.at(-1).actor.id, norma.id);
  assert.throws(() => flow.send({ action: 'phoneOutcome', outcome: 'advance' }), /cada pregunta/);
  answer(flow, 'phone', questionnaire.phone);
  flow.send({ action: 'phoneOutcome', outcome: 'advance' });
  flow.send({ action: 'startInterview' });
  answer(flow, 'interview', questionnaire.interview);
  assert.throws(() => flow.send({ action: 'finishInterview' }), /cada pregunta/);
  assert.throws(() => flow.send({ action: 'score', key: 'service', value: 4 }), /Completa la entrevista/);
  assert.throws(() => flow.send({ action: 'answer', step: 'interview', key: 'pressure', value: 'Otra respuesta' }, norma), /Solo quien inició/);
  answer(flow, 'interview', questionnaire.simulation);
  flow.send({ action: 'finishInterview' });
  assert.equal(flow.candidate.stage, 'evaluation');
  assert.equal(flow.candidate.workflow.interview.completedBy.id, fredy.id);
  assert.throws(() => flow.send({ action: 'score', key: 'service', value: 4 }, norma), /Solo quien inició/);
  assert.throws(() => flow.send({ action: 'score', key: 'service', value: 6 }), /del 1 al 5/);
  flow.send({ action: 'competencyNote', key: 'service', value: 'Dio un ejemplo específico.' });

  for (const { key } of questionnaire.competencies.slice(0, -1)) flow.send({ action: 'score', key, value: 4 });
  assert.equal(flow.candidate.score, 0);
  assert.throws(() => flow.send({ action: 'decide', status: 'hired' }), /Completa la evaluación/);
  flow.send({ action: 'score', key: 'discipline', value: 4 });
  assert.equal(flow.candidate.score, 80);
  assert.equal(flow.candidate.workflow.assessment.service.notes, 'Dio un ejemplo específico.');
  assert.equal(flow.candidate.status, 'evaluation');

  flow.send({ action: 'review', recommendation: 'hire', notes: 'Buena evidencia.' });
  flow.send({ action: 'review', recommendation: 'reserve' }, norma);
  flow.send({ action: 'review', recommendation: 'decline', notes: 'Dudas sobre el horario.' }, norma);
  assert.equal(Object.keys(flow.candidate.workflow.reviews).length, 2);
  assert.equal(flow.candidate.workflow.reviews[fredy.id].recommendation, 'hire');
  assert.throws(() => flow.send({ action: 'decide', status: 'reserve' }), /motivo de la decisión/);
  flow.send({ action: 'decide', status: 'reserve', notes: 'Revisaremos horarios.' }, norma);
  assert.equal(flow.candidate.status, 'reserve');
  assert.equal(flow.candidate.workflow.decision.actor.id, norma.id);
  assert.equal(flow.candidate.workflow.history.at(-1).score, 80);
  flow.send({ action: 'reopen' });
  assert.equal(flow.candidate.status, 'evaluation');
  assert.equal(flow.candidate.score, 80);
  assert.equal(flow.candidate.workflow.reviews[norma.id].notes, 'Dudas sobre el horario.');
});

test('optional phone details can be added to an existing draft without overwriting answers', () => {
  const flow = process();
  const detail = (key, value) => ({ action: 'phoneDetail', key, value });
  assert.throws(() => flow.send(detail('education', 'Preparatoria')), /Inicia el filtro/);
  flow.send({ action: 'startPhone' });
  flow.send({ action: 'answer', step: 'phone', key: 'motivation', value: 'Le interesa cocina.' });
  flow.send(detail('education', 'Preparatoria'));
  flow.send(detail('age', '28'));
  flow.send(detail('currentJob', 'Cocina'));
  flow.send(detail('availability', 'Por las tardes'), norma);
  assert.deepEqual(flow.candidate.workflow.phone.details, {
    education: 'Preparatoria', age: '28', currentJob: 'Cocina', availability: 'Por las tardes',
  });
  assert.equal(flow.candidate.workflow.phone.answers.motivation, 'Le interesa cocina.');
  assert.throws(() => flow.send(detail('age', '28.5')), /edad en años/);
  assert.throws(() => flow.send(detail('unknown', 'dato')), /campo del filtro/);
  flow.send(detail('age', ''));
  assert.equal(flow.candidate.workflow.phone.details.age, '');
});

test('telephone rejection preserves evidence and requires a deliberate, reversible discard', () => {
  const flow = process();
  flow.send({ action: 'startPhone' });
  flow.send({ action: 'answer', step: 'phone', key: 'fit', value: 'El horario no coincide.' });
  flow.send({ action: 'phoneOutcome', outcome: 'decline' });
  assert.equal(flow.candidate.status, 'phone');
  assert.throws(() => flow.send({ action: 'decide', status: 'discarded' }), /motivo de la decisión/);
  flow.send({ action: 'decide', status: 'discarded', notes: 'Incompatibilidad de horario.' });
  assert.equal(flow.candidate.status, 'discarded');
  flow.send({ action: 'reopen' });
  assert.equal(flow.candidate.workflow.phone.outcome, null);
  assert.equal(flow.candidate.workflow.phone.answers.fit, 'El horario no coincide.');
  assert.equal(flow.candidate.workflow.history.at(-2).notes, 'Incompatibilidad de horario.');
});

test('candidate details validate vacante and contact and keep previously valid vacantes editable', () => {
  const input = { fullName: ' Ana Pérez ', phone: '+52 55 0000 0000', position: positions()[0] };
  assert.equal(candidateDetails(input).fullName, 'Ana Pérez');
  assert.throws(() => candidateDetails({ ...input, phone: 'inválido' }), /teléfono válido/);
  assert.throws(() => candidateDetails({ ...input, position: 'Vacante anterior' }), /vacante/);
  assert.equal(candidateDetails({ ...input, position: 'Vacante anterior' }, 'Vacante anterior').position, 'Vacante anterior');
});

test('candidate phones copied with invisible directional marks are saved without those marks', () => {
  const input = { fullName: 'Candidata de prueba', position: positions()[0] };
  assert.equal(candidateDetails({ ...input, phone: '5512345678\u202C' }).phone, '5512345678');
  assert.equal(candidateDetails({ ...input, phone: '\u202A +52 55 1234 5678 \u202C' }).phone, '+52 55 1234 5678');
  assert.throws(() => candidateDetails({ ...input, phone: '5512345678\u202Cx' }), /teléfono válido/);
});

test('all candidate routes require an authenticated administrative account', () => {
  const config = routes({}).routes;
  assert.deepEqual(config.map(route => route.method), ['GET', 'POST', 'GET', 'PATCH']);
  for (const route of config) {
    assert.deepEqual(route.config.auth.strategies, ['users-permissions']);
    assert.deepEqual(route.config.policies, ['api::team-employee.team-admin']);
  }
});

test('different competency grades use their specific weights', () => {
  const grades = [5, 4, 3, 2, 1, 5];
  const assessment = Object.fromEntries(questionnaire.competencies.map(({ key }, index) => [key, { score: grades[index] }]));
  assert.equal(weightedScore(assessment), 71);
  assessment.service.score = 6;
  assert.equal(weightedScore(assessment), 0);
});
