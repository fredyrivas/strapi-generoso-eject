'use strict';

const phone = [
  { key: 'motivation', category: 'Motivación', prompt: '¿Qué te llamó la atención de esta vacante?', lookFor: 'Interés por las actividades, el ambiente o el aprendizaje. Comprensión básica del puesto y motivación compatible con la oportunidad.' },
  { key: 'experience', category: 'Experiencia y preferencias', prompt: '¿Qué disfrutabas más y menos de tu último trabajo o actividad?', lookFor: 'Autoconocimiento, preferencias claras y responsabilidad sobre sus decisiones. Escucha cómo expresa desacuerdos o experiencias negativas.' },
  { key: 'learning', category: 'Aprendizaje', prompt: '¿Qué te gustaría aprender durante los próximos seis meses?', lookFor: 'Curiosidad, objetivos concretos y disposición para desarrollar habilidades.' },
  { key: 'adaptability', category: 'Adaptabilidad', prompt: '¿Prefieres actividades rutinarias o que cambian constantemente? ¿Por qué?', lookFor: 'Flexibilidad, disposición para tareas repetitivas y adaptación a cambios de prioridades.' },
  { key: 'fit', category: 'Compatibilidad', prompt: '¿El sueldo, horario y actividades se ajustan a lo que estás buscando?', lookFor: 'Disponibilidad, expectativas claras y compatibilidad con las condiciones de Generoso. Buscar mejores ingresos no es una señal negativa.' },
];

const interview = [
  { key: 'pressure', category: 'Presión', prompt: 'Cuéntame de una ocasión en la que tenías demasiadas cosas por hacer. ¿Qué hiciste?', lookFor: 'Priorización, comunicación respetuosa, búsqueda de soluciones y capacidad para pedir ayuda bajo presión.', alerts: 'Agresividad, abandono de responsabilidades sin avisar o culpar sistemáticamente a otros.' },
  { key: 'learning', category: 'Aprendizaje', prompt: 'Háblame de un error que cometiste. ¿Qué cambiaste después?', lookFor: 'Reconoce el error, asume su responsabilidad y describe cambios concretos para evitar repetirlo.', alerts: 'Justificaciones constantes, negar los errores o trasladar repetidamente la responsabilidad.' },
  { key: 'initiative', category: 'Iniciativa', prompt: '¿Alguna vez resolviste un problema sin que nadie te lo pidiera?', lookFor: 'Identifica un problema, propone una solución práctica y participa en la mejora.', alerts: 'Pasividad sistemática ante problemas en los que puede ayudar o rechazo a mejoras dentro de sus responsabilidades.' },
  { key: 'teamwork', category: 'Trabajo en equipo', prompt: 'Cuéntame de un desacuerdo con alguien de tu equipo. ¿Cómo lo manejaste?', lookFor: 'Comunicación respetuosa, escucha y colaboración. Cuestionar respetuosamente una decisión es válido.', alerts: 'Descalificaciones, venganza, hostilidad o negativa injustificada a colaborar.' },
  { key: 'service', category: 'Servicio', prompt: '¿Cuándo fue la última vez que ayudaste a alguien sin que fuera tu obligación?', lookFor: 'Empatía, amabilidad y atención a las necesidades de otras personas.', alerts: 'Desprecio, trato hostil o desinterés por las necesidades de los clientes.' },
  { key: 'discipline', category: 'Disciplina', prompt: '¿Cómo manejas las tareas que no te gustan, pero deben hacerse?', lookFor: 'Constancia, responsabilidad y disposición para limpiar, organizar y cumplir tareas. La disciplina es compatible con respetar horarios y descansos.', alerts: 'Evasión sistemática de responsabilidades o rechazo a tareas esenciales del puesto.' },
  { key: 'organization', category: 'Organización', prompt: 'Si tienes varias tareas urgentes y alguien te pide ayuda, ¿cómo decides qué hacer primero?', lookFor: 'Identifica urgencias, establece prioridades y comunica su decisión.', alerts: 'Falta de comunicación o decisiones improvisadas que ponen en riesgo la operación.' },
];

const simulation = [
  { key: 'simulationInitial', category: 'Escenario inicial', prompt: 'Hay varias comandas pendientes, llegan tres clientes nuevos y un compañero necesita ayuda. ¿Qué haces primero?' },
  { key: 'simulationChange', category: 'Cambio de escenario', prompt: 'Un cliente comienza a molestarse por el tiempo de espera. ¿Qué haces?' },
];

const competencies = [
  { key: 'service', label: 'Actitud de servicio', weight: 25 },
  { key: 'pressure', label: 'Manejo de presión', weight: 20 },
  { key: 'initiative', label: 'Iniciativa y solución', weight: 20 },
  { key: 'learning', label: 'Aprendizaje', weight: 15 },
  { key: 'teamwork', label: 'Trabajo en equipo', weight: 10 },
  { key: 'discipline', label: 'Orden y disciplina', weight: 10 },
];

const questionnaire = { phone, interview, simulation, competencies };
const defaultPositions = ['Cocina', 'Servicio', 'Apoyo general'];
const sources = ['Indeed', 'WhatsApp', 'Referido', 'Otro'];

function positions() {
  const configured = [...new Set((process.env.TEAM_RECRUITMENT_POSITIONS ?? '').split(',').map(value => value.trim()).filter(value => value && value.length <= 100))];
  return configured.length ? configured : defaultPositions;
}

function weightedScore(assessment) {
  if (!competencies.every(({ key }) => {
    const score = assessment[key]?.score;
    return Number.isInteger(score) && score >= 1 && score <= 5;
  })) return 0;
  return competencies.reduce((sum, { key, weight }) => sum + assessment[key].score * weight / 5, 0);
}

module.exports = { questionnaire, positions, sources, weightedScore };
