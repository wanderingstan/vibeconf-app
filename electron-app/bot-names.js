// bot-names.js — suggested names for a new bot (#187).
//
// The wizard used to start with an empty name field, so anyone who skipped it got
// a bot called "Unnamed bot" — on its tile, in the room, in front of everyone.
// Pre-filling with a real name means the skip path produces something reasonable
// and the field is still yours to type over.
//
// TWO RULES SHAPED THIS LIST:
//
// 1. NOT A WORD YOU'D HEAR IN A MEETING. This is the one that prevents a real
//    bug: the bot wakes on hearing its own name in the captions, so a bot called
//    Iris, Ivy, June, Hazel, Grace, Dawn, Joy or Dev would trigger on ordinary
//    conversation. Homophones count too — "Mai" is "my", which would fire
//    constantly.
//
//    THE TEST IS MEETING VOCABULARY, NOT THE DICTIONARY. That distinction is
//    the whole rule, and it was learned the slow way — the list first banned
//    anything that appears in a dictionary, which is far too strict. What
//    matters is how often the word turns up in the rooms this app is actually
//    used in. "Grace" and "Dawn" are out because people say them at work.
//    Bender, Robin, Earl, Bob, John and Pepper are IN despite being words,
//    because nobody says "bob", "earl" or "pass the pepper" on a standup. They
//    will misfire once in a while; people work it out in about one call, and
//    the names are worth it.
//
//    So when adding a name, do not ask "is this a word?" — ask "would this come
//    up in a typical meeting?" Only the second question predicts false wakes.
//
// 2. PRONOUNCEABLE BY AN ENGLISH TTS. The bot says its own name aloud. Names
//    needing diacritics or non-English phonology get mangled, so the list favours
//    spellings an English synthesiser reads correctly — which is why some obvious
//    international names are missing.
//
// Names shared with TTS voices (Samantha, Daniel, Ava, Nora, Zoe…) and with bots
// already around this project (Jimmy, Alice, Pepper) are deliberately KEPT: they
// are good names, and the ambiguity is cosmetic rather than behavioural. Revisit
// only if it actually causes confusion in a log. (This paragraph claimed Pepper
// for a while before the list actually contained it — a test now checks that the
// names named here are really present, so the comment cannot drift again.)
//
// Roughly even split, and deliberately wide — a first-run bot should not always
// sound like it came from the same village. A third list of famous robots rides
// along outside that split, since none of them are gendered.

const FEMININE = [
  // Spanish + Portuguese
  'Elena', 'Paloma', 'Lucia', 'Marisol', 'Valentina', 'Pilar', 'Camila', 'Adriana',
  'Beatriz', 'Luana', 'Mariana',
  // French
  'Colette', 'Margot', 'Sylvie', 'Odile', 'Celine', 'Manon', 'Elodie', 'Genevieve',
  // Italian
  'Bianca', 'Chiara', 'Alessia', 'Livia', 'Marcella', 'Fiorella',
  // German + Nordic
  'Annika', 'Ingrid', 'Freya', 'Astrid', 'Maren', 'Birgit', 'Sigrid',
  // Slavic
  'Mira', 'Katya', 'Zora', 'Vesna', 'Danica', 'Kasia', 'Marta',
  // Greek
  'Thalia', 'Daphne', 'Eleni', 'Athena', 'Xenia',
  // Hebrew
  'Talia', 'Shira', 'Eliana', 'Naomi', 'Yael',
  // Arabic + Persian + Turkish
  'Layla', 'Amina', 'Salma', 'Samira', 'Yasmin', 'Farida', 'Nadira',
  'Roxana', 'Soraya', 'Darya', 'Esra',
  // South Asian
  'Priya', 'Anjali', 'Meera', 'Kavita', 'Divya', 'Asha', 'Leela', 'Nisha', 'Radha',
  // East Asian
  'Yuki', 'Aiko', 'Naoko', 'Sakura', 'Haruka', 'Chiyo', 'Mina',
  // African
  'Amara', 'Zuri', 'Imani', 'Makena',
  // Previously held back only for overlapping a TTS voice or an existing bot
  'Nora', 'Zoe', 'Samantha', 'Ava', 'Alice', 'Serena', 'Tessa', 'Milena', 'Clara',
  'Sara', 'Anna', 'Amira', 'Luciana', 'Tara', 'Fiona', 'Nadia', 'Sofia', 'Isabel',
  'Petra', 'Ilona', 'Renata', 'Simone', 'Aisha', 'Sunita', 'Indira', 'Keiko',
  'Rosa', 'Carmen', 'Greta', 'Helena', 'Marisa', 'Alba', 'Ines', 'Elsa', 'Agata',
  'Ilse', 'Dalia', 'Rania', 'Zainab', 'Lakshmi', 'Padma', 'Rina', 'Yuna',
  'Nomsa', 'Rosalia',
  // Common in the US — the majority of the audience, so the list should feel
  // familiar more often than not. Same word rule: Lily, Ivy, Grace, Violet,
  // Willow, Daisy, Jade, Ruby, Autumn, Nova and Aria are all names people
  // actually use and all excluded, because the bot would wake on them.
  'Emma', 'Olivia', 'Charlotte', 'Amelia', 'Abigail', 'Emily', 'Elizabeth', 'Ella',
  'Chloe', 'Penelope', 'Hannah', 'Stella', 'Natalie', 'Leah', 'Audrey', 'Bella',
  'Claire', 'Lucy', 'Caroline', 'Emilia', 'Allison', 'Julia', 'Vivian', 'Sophie',
  'Madeline', 'Lydia', 'Josephine', 'Katherine', 'Diana', 'Rachel', 'Megan',
  'Nicole', 'Michelle', 'Rebecca', 'Danielle', 'Christine', 'Andrea', 'Marie',
  // Asked for by name. Robin is a word, and allowed — see rule 1.
  'Kate', 'Maria', 'Sandra', 'Lisa', 'Mavi',
  'Melinda', 'Valerie', 'Robin', 'Analita', 'Aurelia', 'Annabeth',
  'Victoria',
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
  'Anders', 'Lars', 'Bjorn', 'Magnus', 'Kasper', 'Stellan', 'Henrik',
  'Gustav',
  // Slavic
  'Milan', 'Dimitri', 'Vasily', 'Bohdan', 'Tomas', 'Nikolai', 'Radek',
  // Greek
  'Nikos', 'Stavros', 'Leander', 'Andros',
  // Hebrew
  'Elan', 'Gideon', 'Ezra', 'Tobias', 'Asher',
  // Arabic + Persian + Turkish
  'Omar', 'Karim', 'Rashid', 'Tariq', 'Anwar', 'Faris', 'Hakim',
  'Darius', 'Farhad', 'Bahram', 'Kerem',
  // South Asian
  'Arjun', 'Ravi', 'Vikram', 'Rohan', 'Nikhil', 'Kiran', 'Sanjay', 'Rajesh',
  // East Asian
  'Kenji', 'Daichi', 'Hiroshi', 'Takeshi', 'Minho', 'Jiro', 'Satoshi',
  // African
  'Kwame', 'Tendai', 'Chidi', 'Sefu', 'Jabari', 'Kofi', 'Zuberi', 'Amadi',
  // Previously held back only for overlapping a TTS voice or an existing bot
  'Daniel', 'Thomas', 'Oliver', 'Xander', 'Victor', 'Hector', 'Pablo', 'Marcel',
  'Antoine', 'Aldo', 'Klaus', 'Stefan', 'Boris', 'Ivan', 'Pavel', 'Yuri', 'Levi',
  'Amos', 'Yusuf', 'Idris', 'Malik', 'Samir', 'Reza', 'Pranav', 'Aditya', 'Varun',
  'Naveen', 'Haruki', 'Femi', 'Themba', 'Jimmy',
  // Common in the US. Same word rule, which costs a lot of popular ones here:
  // Jack, Mason, Hunter, Cooper, Parker, Carter, Brooks, Miles, Angel, Roman,
  // Christian and Maverick are all excluded as ordinary words or occupations.
  'Liam', 'Noah', 'Elijah', 'James', 'William', 'Benjamin', 'Lucas',
  'Alexander', 'Michael', 'Ethan', 'Jacob', 'Logan', 'Jackson', 'Sebastian',
  'Owen', 'Theodore', 'Samuel', 'Joseph', 'David', 'Matthew', 'Luke',
  'Julian', 'Gabriel', 'Isaac', 'Lincoln', 'Anthony', 'Dylan', 'Charles',
  'Andrew', 'Nathan', 'Caleb', 'Adrian', 'Nolan', 'Cameron', 'Connor',
  'Nicholas', 'Dominic', 'Evan',
  // The people who built this thing, and Stan's dad.
  'Stan', 'Seth', 'Vern',
  // Asked for by name. Bob and John are words, and allowed — see rule 1.
  'Trevor', 'Jeff', 'Steve', 'John', 'Jordan', 'Alex', 'Chris', 'Joshua',
  'Robert', 'Bob', 'Fabian', 'Peter', 'Kenny',
  // Earl is a rank and a tea, and allowed — see rule 1.
  'Dan', 'Earl', 'Henry'
];

// Famous robots, computers and AIs. A bot named after one is a small joke that
// lands immediately, and unlike the two lists above these carry no gender, so
// they sit outside the even split rather than tipping it.
//
// Rule 1 still applies. Rule 2 turned out to be over-strict here, and the list
// below reflects a real test call rather than a guess about what Google can hear:
//
//     "When I talk about the robot C-3PO, how does that get transcribed?
//      What about R2D2?"
//
// Every one came back exactly right, hyphens and digits included. So R2D2 and
// C-3PO are in, and the shape rule was widened to allow digits, hyphens and
// spaces instead of insisting on one plain word.
//
// Two-word names are in for the same reason, and they are actually SAFER than
// single words under rule 1: mention detection is a substring match, so a bot
// called Iron Giant wakes on "iron giant" together — far rarer in conversation
// than either "iron" or "giant" alone. That is why the two-word icons are here
// in full while a bare "Giant" would never be allowed.
//
// Still out, on rule 1:
//
//   Data, Ash, Zen          ordinary words — "the data says", "ash tray"
//   Vision, Friday, Colossus, Bumblebee, Tars, Holly    likewise
//
//   Alexa, Siri             EXCLUDED FOR A DIFFERENT AND BETTER REASON: the bot
//                           says its own name aloud, in a room full of phones and
//                           speakers. A bot introducing itself would set off every
//                           assistant within earshot. Cortana is here because it
//                           is discontinued and wakes nothing.
const ROBOTIC = [
  // Film
  'Hal', 'Tron', 'Robby', 'Wally', 'Megatron', 'Jarvis', 'Ultron',
  'Baymax', 'Chappie', 'Robocop', 'Skynet', 'Astro', 'Talos', 'Terminator',
  // The canonical rule-1 judgement call, and the one the rule is written around.
  'Bender',
  // Film — confirmed intact through Google's captions on a live test call
  'R2D2',
  // Film — the two-word ones, safer than either word on its own
  'Optimus Prime', 'Iron Giant', 'Johnny Five',
  // Television
  'Marvin', 'Rosie', 'Vicki', 'Ziggy', 'Orac', 'Maeve', 'Dolores',
  'Bernard', 'Roy',
  // Books
  'Multivac', 'Wintermute', 'Deep Thought',
  // Real, or real enough
  'Eliza', 'Watson', 'Turing', 'Clippy', 'Cortana',
  // SoftBank's Pepper, and one of this project's own bots.
  'Pepper',
];

// EXCLUDED — great names we WANTED but had to drop, kept here on purpose so a fan
// of the name can see it was considered and why it's not offered. A third rule,
// learned by testing (scripts/name-transcription-test.mjs): a RANDOM suggestion
// must clear the LOWEST-COMMON-DENOMINATOR bar — pronounce + transcribe cleanly
// even with a naive voice (macOS `say`) on Google Meet's live captions. A user
// who deliberately TYPES one of these still gets it; the wizard just won't hand
// it out unprompted, because the bot would answer to a mangled name out of the
// box. (These stay COMMENTS, not a data list, so they never enter the draw.)
//
//   Robotic (audited 2026-08-02):
//     C-3PO   — `say` renders it "ku-negative-three-poe"; Meet then captions
//               "c3po". Pure pronunciation failure, not a Meet miss.
//     Pris    — `say` says "pree" (French); Meet hears "chris". "Priss" spelling
//               would fix the voice but collides with the common name Chris.
//     Gort    — spoken cleanly, Meet still captions "gourd".
//     Twiki   — Meet hears "twiggy".
//     Kryten  — Meet hears "critten".
//     Giskard — Meet hears "just" — the worst mangle of the set.
//     Daneel  — Meet hears "daniel": renamed to a different, meeting-common name
//               (also a mild rule-1 trigger risk).
//
//   Feminine (audited 2026-08-02) — Meet mistranscribed each (heard → in quotes):
//     Ludmila "lud" · Zaina "zamer" · Thandi "sandy" · Katrin "catherine" ·
//     Hana "hannah" · Lena "lima" · Nasrin "nazreen" · Emi "emmy"
//
//   Masculine (audited 2026-08-02):
//     Soren "sauron" · Nils "mills" · Noam "gnome" · Nasser "nasa" ·
//     Amit "ahmed" · Emre "emery" · Wyatt "wild"
//
// Several of the above read as international names macOS `say`'s English voice
// itself fumbles rather than a Meet failure — but with 400+ names to draw from we
// only offer ones tested to survive Meet's captions, so they're out either way.

// Every name, each appearing once. This is the LIST — what exists — and it is
// what callers should read to ask "is this name in the pool?".
const BOT_NAMES = [...FEMININE, ...MASCULINE, ...ROBOTIC];

// The robots are outnumbered about 8:1 by ordinary names, so on a straight
// uniform draw they came up roughly one spin in ten — and they are the part of
// the wheel people actually enjoy. Weighting them makes the draw behave as
// though there were ~130 of them rather than 44, so a robot turns up closer to
// one spin in four.
//
// Done by repeating the entries rather than with a branch, so there is exactly
// one draw and one code path. That keeps `taken` filtering, the empty-pool
// fallback and the injected `random` all working unchanged.
const ROBOT_WEIGHT = 3;
const DRAW_POOL = [...FEMININE, ...MASCULINE, ...ROBOTIC, ...ROBOTIC, ...ROBOTIC];

// One name at random, robots over-represented per ROBOT_WEIGHT.
//
// `taken` lets a caller avoid names already in use on this machine, so someone
// setting up a second bot doesn't get handed the first one's name. Falls back to
// the full list rather than failing if everything is somehow taken — a duplicate
// name is worse than nothing, but no name at all is worse still.
function randomBotName({ taken = [], random = Math.random } = {}) {
  const used = new Set(taken.map((n) => String(n || '').trim().toLowerCase()));
  const pool = DRAW_POOL.filter((n) => !used.has(n.toLowerCase()));
  const from = pool.length > 0 ? pool : DRAW_POOL;
  return from[Math.floor(random() * from.length)];
}

module.exports = { BOT_NAMES, FEMININE, MASCULINE, ROBOTIC, ROBOT_WEIGHT, randomBotName };
