// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button), en and fr.
// No text the user typed is ever echoed (a key may sit in the wrong field):
// a configured station is named by its number, a station found by the name
// Trafikverket gives it.
// -----------------------------------------------------------------------------

/** "2026-10-20T18:00:00Z" -> "18:00 UTC". */
export const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why the account or a station has no fresh value. */
export const REASONS = {
  refused: { en: 'API key refused', fr: "clé d'API refusée" },
  limited: { en: 'too many requests', fr: 'trop de requêtes' },
  limitedPaused: { en: 'too many requests (pause)', fr: 'trop de requêtes (pause)' },
  busy: { en: 'service unavailable', fr: 'service indisponible' },
  busyPaused: { en: 'service unavailable (pause)', fr: 'service indisponible (pause)' },
  rejected: { en: 'query refused by Trafikverket', fr: 'requête refusée par Trafikverket' },
  failed: { en: 'no answer', fr: 'pas de réponse' },
  invalid: {
    en: 'not an answer of Trafikverket',
    fr: "réponse qui n'est pas celle de Trafikverket",
  },
  stale: { en: 'no recent measurement', fr: 'pas de mesure récente' },
};

export const reason = (kind) => REASONS[kind] ?? REASONS.failed;

const INVALID = {
  station: { en: 'not understood', fr: 'non comprise' },
  duplicate: { en: 'entered twice', fr: 'saisie deux fois' },
};

export const T = {
  notConfigured: {
    en: 'Enter your API key of the Trafikverket open API and at least one road weather station.',
    fr: "Saisissez votre clé de l'API ouverte de Trafikverket et au moins une station météo routière.",
  },
  noKey: {
    en: 'Enter your API key of the Trafikverket open API (free, on data.trafikverket.se).',
    fr: "Saisissez votre clé de l'API ouverte de Trafikverket (gratuite, sur data.trafikverket.se).",
  },
  noStation: {
    en: 'Enter at least one road weather station (its name or its id).',
    fr: 'Saisissez au moins une station météo routière (son nom ou son identifiant).',
  },
  keyInvalid: {
    en: 'API key not valid: it holds a space, a line break or a character the keys of Trafikverket do not use. Copy it again from data.trafikverket.se.',
    fr: "Clé d'API non valide : elle contient une espace, un retour à la ligne ou un caractère que les clés de Trafikverket n'utilisent pas. Copiez-la à nouveau depuis data.trafikverket.se.",
  },
  invalidSlots: (invalid) => ({
    en: invalid.map((i) => `Station ${i.slot} ignored: ${INVALID[i.why].en}`).join('. '),
    fr: invalid.map((i) => `Station ${i.slot} ignorée : ${INVALID[i.why].fr}`).join('. '),
  }),
  missing: (slots) => ({
    en: `Station ${slots.join(', ')} not found at Trafikverket (write the name exactly as on its map, or the id)`,
    fr: `Station ${slots.join(', ')} introuvable chez Trafikverket (écrivez le nom exactement comme sur sa carte, ou l'identifiant)`,
  }),
  ambiguous: ({ slot, ids }) => ({
    en: `Station ${slot} matches several stations (${ids.join(', ')}): enter one of these ids`,
    fr: `La station ${slot} correspond à plusieurs stations (${ids.join(', ')}) : saisissez l'un de ces identifiants`,
  }),
  refusedHelp: {
    en: 'Trafikverket refused the API key: check it on data.trafikverket.se. Nothing is sent again until the key changes, or until the test button succeeds once the interval has passed.',
    fr: "Trafikverket a refusé la clé d'API : vérifiez-la sur data.trafikverket.se. Plus rien n'est envoyé tant que la clé ne change pas, ou jusqu'à ce que le bouton de test réussisse, une fois l'intervalle écoulé.",
  },
  nextRead: (at) => ({
    en: `next read possible at ${utcTime(at)}`,
    fr: `prochaine lecture possible à ${utcTime(at)}`,
  }),
  pausedUntil: (until) => ({
    en: `paused until ${utcTime(until)}`,
    fr: `en pause jusqu'à ${utcTime(until)}`,
  }),
  /** The connected status: what is read, how often, and what fails. */
  ok: ({ stations, interval, failing = [] }) => {
    let en = `${stations} Trafikverket road weather station(s), read every ${interval} min.`;
    let fr = `${stations} station(s) météo routière(s) Trafikverket, lue(s) toutes les ${interval} min.`;
    if (failing.length > 0) {
      en += ` Without value: ${failing.map((f) => `${f.name} (${reason(f.kind).en})`).join(', ')}.`;
      fr += ` Sans valeur : ${failing.map((f) => `${f.name} (${reason(f.kind).fr})`).join(', ')}.`;
    }
    return { en, fr };
  },
};
