'use strict';

const { errors: { ValidationError, ForbiddenError } } = require('@strapi/utils');
const { questionnaire, positions, sources, weightedScore } = require('./questionnaire');

const stages = ['new', 'phone', 'interview', 'evaluation'];
const finalStatuses = ['hired', 'reserve', 'discarded'];
const statuses = [...stages, ...finalStatuses];
const recommendations = ['hire', 'reserve', 'decline'];

function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new ValidationError(`Revisa el campo «${label}».`);
  }
  return required ? value.trim() : value;
}

function requireChoice(value, choices, message) {
  if (!choices.includes(value)) throw new ValidationError(message);
  return value;
}

function candidateDetails(input, currentPosition) {
  const phone = text(input.phone, 'teléfono', 32, true).replace(/\p{Bidi_Control}/gu, '').trim();
  const digits = phone.replace(/\D/g, '').length;
  if (digits < 7 || digits > 15 || !/^\+?[\d().\s-]+$/.test(phone)) throw new ValidationError('Escribe un teléfono válido.');
  return {
    fullName: text(input.fullName, 'nombre completo', 150, true),
    phone,
    position: requireChoice(input.position, [...positions(), currentPosition].filter(Boolean), 'Selecciona una vacante.'),
    source: requireChoice(input.source ?? '', ['', ...sources], 'Selecciona una fuente válida.'),
    notes: text(input.notes ?? '', 'notas generales', 4000),
  };
}

function actorFrom(user) {
  return { id: user.id, name: user.username || user.email };
}

function event(actor, at, action, details = {}) {
  return { actor, at, action, ...details };
}

function newWorkflow(actor, at) {
  return {
    phone: null, interview: null, assessment: {}, reviews: {}, decision: null,
    history: [event(actor, at, 'created', { stage: 'new' })],
  };
}

function startStage(actor, at) {
  return { interviewer: actor, startedAt: at, completedAt: null, completedBy: null, answers: {}, notes: '' };
}

function requireStage(allowed, message) {
  if (!allowed) throw new ValidationError(message);
}

function requireInterviewer(interview, actor) {
  if (interview.interviewer.id !== actor.id) throw new ForbiddenError('Solo quien inició la entrevista puede editarla y calificarla.');
}

function requireAnswers(answers, questions) {
  if (!questions.every(({ key }) => answers[key]?.trim())) {
    throw new ValidationError('Registra una observación en cada pregunta para continuar.');
  }
}

function applyAction(candidate, input, actor, at) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('La operación no es válida.');
  const workflow = structuredClone(candidate.workflow);
  let { stage } = candidate;
  if (input.action === 'details') return candidateDetails(input, candidate.position);
  if (workflow.decision && !['reopen', 'review'].includes(input.action)) throw new ValidationError('El expediente está cerrado. Reábrelo para continuar.');
  switch (input.action) {
    case 'startPhone':
      requireStage(stage === 'new', 'El filtro telefónico ya se inició.');
      workflow.phone = { ...startStage(actor, at), outcome: null, pending: '' };
      stage = 'phone';
      break;
    case 'phoneDetail': {
      requireStage(workflow.phone, 'Inicia el filtro telefónico antes de registrar sus datos.');
      const key = requireChoice(input.key, ['education', 'age', 'currentJob', 'availability'], 'El campo del filtro no es válido.');
      const value = text(input.value, 'datos del filtro', 250);
      if (key === 'age' && value && (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 120)) {
        throw new ValidationError('Escribe una edad en años, entre 1 y 120.');
      }
      workflow.phone.details = { ...workflow.phone.details, [key]: value };
      break;
    }
    case 'answer': {
      const step = requireChoice(input.step, ['phone', 'interview'], 'La etapa no es válida.');
      requireStage(workflow[step], 'Inicia la etapa antes de registrar respuestas.');
      if (step === 'interview') requireInterviewer(workflow.interview, actor);
      const questions = step === 'phone' ? questionnaire.phone : [...questionnaire.interview, ...questionnaire.simulation];
      requireChoice(input.key, questions.map(({ key }) => key), 'La pregunta no es válida.');
      const answer = text(input.value, 'observaciones', 4000);
      if (workflow[step].completedAt && !answer) throw new ValidationError('Conserva una observación para esta pregunta completada.');
      workflow[step].answers[input.key] = answer;
      break;
    }
    case 'stageNotes': {
      const step = requireChoice(input.step, ['phone', 'interview'], 'La etapa no es válida.');
      requireStage(workflow[step], 'Inicia la etapa antes de registrar observaciones.');
      if (step === 'interview') requireInterviewer(workflow.interview, actor);
      workflow[step].notes = text(input.value, 'observaciones finales', 4000);
      break;
    }
    case 'phoneOutcome': {
      requireStage(stage === 'phone', 'El proceso ya avanzó del filtro telefónico.');
      const outcome = requireChoice(input.outcome, ['advance', 'pending', 'decline'], 'Selecciona un resultado del filtro.');
      const pending = outcome === 'pending' ? text(input.reason, 'información pendiente', 1000, true) : '';
      if (workflow.phone.outcome === outcome && workflow.phone.pending === pending) break;
      if (outcome === 'advance') requireAnswers(workflow.phone.answers, questionnaire.phone);
      Object.assign(workflow.phone, {
        outcome, pending, completedAt: outcome === 'pending' ? null : at, completedBy: outcome === 'pending' ? null : actor,
      });
      workflow.history.push(event(actor, at, 'phoneOutcome', { outcome, ...(pending ? { notes: pending } : {}) }));
      break;
    }
    case 'startInterview':
      requireStage(stage === 'phone' && workflow.phone?.outcome === 'advance', 'El filtro telefónico debe tener resultado Avanza.');
      workflow.interview = startStage(actor, at);
      stage = 'interview';
      break;
    case 'finishInterview':
      requireStage(stage === 'interview', 'La entrevista presencial no está pendiente.');
      requireInterviewer(workflow.interview, actor);
      requireAnswers(workflow.interview.answers, [...questionnaire.interview, ...questionnaire.simulation]);
      Object.assign(workflow.interview, { completedAt: at, completedBy: actor });
      stage = 'evaluation';
      break;
    case 'score':
    case 'competencyNote': {
      requireStage(stage === 'evaluation', 'Completa la entrevista antes de evaluar competencias.');
      requireInterviewer(workflow.interview, actor);
      const key = requireChoice(input.key, questionnaire.competencies.map(item => item.key), 'La competencia no es válida.');
      const assessment = workflow.assessment[key] ?? { score: null, notes: '' };
      if (input.action === 'score') assessment.score = requireChoice(input.value, [1, 2, 3, 4, 5], 'Elige una calificación del 1 al 5.');
      else assessment.notes = text(input.value, 'observación de la competencia', 4000);
      workflow.assessment[key] = assessment;
      break;
    }
    case 'review': {
      requireStage(stage === 'evaluation', 'Completa la entrevista para registrar una recomendación.');
      const recommendation = requireChoice(input.recommendation, recommendations, 'Selecciona una recomendación.');
      const notes = text(input.notes ?? '', 'comentario', 4000);
      workflow.reviews[actor.id] = { actor, recommendation, notes, at };
      break;
    }
    case 'decide': {
      const status = requireChoice(input.status, finalStatuses, 'Selecciona una decisión final.');
      const earlyDiscard = stage === 'phone' && workflow.phone?.outcome === 'decline' && status === 'discarded';
      requireStage(earlyDiscard || (stage === 'evaluation' && weightedScore(workflow.assessment) > 0), 'Completa la evaluación antes de cerrar el expediente.');
      const disagreement = new Set(Object.values(workflow.reviews).map(review => review.recommendation)).size > 1;
      const notes = text(input.notes ?? '', 'motivo de la decisión', 4000, status === 'discarded' || disagreement);
      workflow.decision = { status, actor, at, notes };
      workflow.history.push(event(actor, at, 'decide', { status, notes, score: weightedScore(workflow.assessment) || null }));
      break;
    }
    case 'reopen':
      requireStage(workflow.decision && ['reserve', 'discarded'].includes(workflow.decision.status), 'Solo se pueden reabrir expedientes en reserva o descartados.');
      if (stage === 'phone') Object.assign(workflow.phone, { outcome: null, completedAt: null, completedBy: null });
      workflow.decision = null;
      workflow.history.push(event(actor, at, 'reopen', { stage }));
      break;
    default:
      throw new ValidationError('La operación no es válida.');
  }
  if (stage !== candidate.stage) workflow.history.push(event(actor, at, 'stage', { stage }));
  return { workflow, stage, status: workflow.decision?.status ?? stage, score: weightedScore(workflow.assessment) };
}

module.exports = { actorFrom, applyAction, candidateDetails, newWorkflow, stages, statuses };
