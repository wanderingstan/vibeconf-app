// bot-names.js — suggested names for a new bot (#187).
//
// The wizard used to start with an empty name field, so anyone who skipped it got
// a bot called "Unnamed bot" — on its tile, in the room, in front of everyone.
// Pre-filling with a real name means the skip path produces something reasonable
// and the field is still yours to type over.
//
// TWO RULES SHAPED THIS LIST:
//
// 1. NOT ALSO A COMMON WORD. This is the one that prevents a real bug: the bot
//    wakes on hearing its own name in the captions, so a bot called Iris, Ivy,
//    June, Hazel, Grace, Dawn, Joy or Dev would trigger on ordinary conversation.
//    Homophones count too — "Mai" is "my", which would fire constantly. A false
//    wake is worse than a dull name, so this rule is applied strictly and costs
//    the list some otherwise lovely entries.
//
// 2. PRONOUNCEABLE BY AN ENGLISH TTS. The bot says its own name aloud. Names
//    needing diacritics or non-English phonology get mangled, so the list favours
//    spellings an English synthesiser reads correctly — which is why some obvious
//    international names are missing.
//
// Names shared with TTS voices (Samantha, Daniel, Ava, Nora, Zoe…) and with bots
// already around this project (Jimmy, Alice, Pepper) are deliberately KEPT: they
// are good names, and the ambiguity is cosmetic rather than behavioural. Revisit
// only if it actually causes confusion in a log.
//
// Roughly even split, and deliberately wide — a first-run bot should not always
// sound like it came from the same village.

const FEMININE = [
  // Spanish + Portuguese
  'Elena', 'Paloma', 'Lucia', 'Marisol', 'Valentina', 'Pilar', 'Camila', 'Adriana',
  'Beatriz', 'Luana', 'Mariana',
  // French
  'Colette', 'Margot', 'Sylvie', 'Odile', 'Celine', 'Manon', 'Elodie', 'Genevieve',
  // Italian
  'Bianca', 'Chiara', 'Alessia', 'Livia', 'Marcella', 'Fiorella',
  // German + Nordic
  'Annika', 'Ingrid', 'Freya', 'Astrid', 'Lena', 'Maren', 'Birgit', 'Sigrid', 'Katrin',
  // Slavic
  'Mira', 'Katya', 'Zora', 'Vesna', 'Danica', 'Kasia', 'Marta', 'Ludmila',
  // Greek
  'Thalia', 'Daphne', 'Eleni', 'Athena', 'Xenia',
  // Hebrew
  'Talia', 'Shira', 'Eliana', 'Naomi', 'Yael',
  // Arabic + Persian + Turkish
  'Layla', 'Amina', 'Salma', 'Zaina', 'Samira', 'Yasmin', 'Farida', 'Nadira',
  'Roxana', 'Soraya', 'Nasrin', 'Darya', 'Esra',
  // South Asian
  'Priya', 'Anjali', 'Meera', 'Kavita', 'Divya', 'Asha', 'Leela', 'Nisha', 'Radha',
  // East Asian
  'Yuki', 'Aiko', 'Naoko', 'Sakura', 'Haruka', 'Chiyo', 'Mina',
  // African
  'Amara', 'Zuri', 'Imani', 'Thandi', 'Makena',
  // Previously held back only for overlapping a TTS voice or an existing bot
  'Nora', 'Zoe', 'Samantha', 'Ava', 'Alice', 'Serena', 'Tessa', 'Milena', 'Clara',
  'Sara', 'Anna', 'Amira', 'Luciana', 'Tara', 'Fiona', 'Nadia', 'Sofia', 'Isabel',
  'Petra', 'Ilona', 'Renata', 'Simone', 'Aisha', 'Sunita', 'Indira', 'Keiko', 'Emi',
  'Rosa', 'Carmen', 'Greta', 'Helena', 'Marisa', 'Alba', 'Ines', 'Elsa', 'Agata',
  'Ilse', 'Dalia', 'Rania', 'Zainab', 'Lakshmi', 'Padma', 'Rina', 'Yuna', 'Hana',
  'Nomsa', 'Rosalia',
];

const MASCULINE = [
  // Latin + Anglo
  'Milo', 'Felix', 'Rufus', 'Ambrose', 'Barnaby', 'Hugo', 'Otis', 'Silas', 'Wendell',
  'Cyrus', 'Everett',
  // Spanish + Portuguese
  'Mateo', 'Diego', 'Rafael', 'Emilio', 'Javier', 'Alonso', 'Salvador', 'Ramon',
  'Andres', 'Tiago', 'Vasco', 'Duarte',
  // French
  'Bastien', 'Olivier', 'Julien', 'Pascal', 'Lucien', 'Armand',
  // Italian
  'Enzo', 'Lorenzo', 'Matteo', 'Fabio', 'Sergio', 'Bruno', 'Dante', 'Rocco', 'Silvio',
  // German + Nordic
  'Anders', 'Lars', 'Bjorn', 'Magnus', 'Kasper', 'Stellan', 'Henrik', 'Soren', 'Nils',
  'Gustav',
  // Slavic
  'Milan', 'Dimitri', 'Vasily', 'Bohdan', 'Tomas', 'Nikolai', 'Radek',
  // Greek
  'Nikos', 'Stavros', 'Leander', 'Andros',
  // Hebrew
  'Elan', 'Noam', 'Gideon', 'Ezra', 'Tobias', 'Asher',
  // Arabic + Persian + Turkish
  'Omar', 'Karim', 'Rashid', 'Tariq', 'Nasser', 'Anwar', 'Faris', 'Hakim',
  'Darius', 'Farhad', 'Bahram', 'Emre', 'Kerem',
  // South Asian
  'Arjun', 'Ravi', 'Vikram', 'Rohan', 'Nikhil', 'Kiran', 'Sanjay', 'Amit', 'Rajesh',
  // East Asian
  'Kenji', 'Daichi', 'Hiroshi', 'Takeshi', 'Minho', 'Jiro', 'Satoshi',
  // African
  'Kwame', 'Tendai', 'Chidi', 'Sefu', 'Jabari', 'Kofi', 'Zuberi', 'Amadi',
  // Previously held back only for overlapping a TTS voice or an existing bot
  'Daniel', 'Thomas', 'Oliver', 'Xander', 'Victor', 'Hector', 'Pablo', 'Marcel',
  'Antoine', 'Aldo', 'Klaus', 'Stefan', 'Boris', 'Ivan', 'Pavel', 'Yuri', 'Levi',
  'Amos', 'Yusuf', 'Idris', 'Malik', 'Samir', 'Reza', 'Pranav', 'Aditya', 'Varun',
  'Naveen', 'Haruki', 'Femi', 'Themba', 'Jimmy',
];

const BOT_NAMES = [...FEMININE, ...MASCULINE];

// One name, uniformly at random.
//
// `taken` lets a caller avoid names already in use on this machine, so someone
// setting up a second bot doesn't get handed the first one's name. Falls back to
// the full list rather than failing if everything is somehow taken — a duplicate
// name is worse than nothing, but no name at all is worse still.
function randomBotName({ taken = [], random = Math.random } = {}) {
  const used = new Set(taken.map((n) => String(n || '').trim().toLowerCase()));
  const pool = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  const from = pool.length > 0 ? pool : BOT_NAMES;
  return from[Math.floor(random() * from.length)];
}

module.exports = { BOT_NAMES, FEMININE, MASCULINE, randomBotName };
