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
  // Common in the US — the majority of the audience, so the list should feel
  // familiar more often than not. Same word rule: Lily, Ivy, Grace, Violet,
  // Willow, Daisy, Jade, Ruby, Autumn, Nova and Aria are all names people
  // actually use and all excluded, because the bot would wake on them.
  'Emma', 'Olivia', 'Charlotte', 'Amelia', 'Abigail', 'Emily', 'Elizabeth', 'Ella',
  'Chloe', 'Penelope', 'Hannah', 'Stella', 'Natalie', 'Leah', 'Audrey', 'Bella',
  'Claire', 'Lucy', 'Caroline', 'Emilia', 'Allison', 'Julia', 'Vivian', 'Sophie',
  'Madeline', 'Lydia', 'Josephine', 'Katherine', 'Diana', 'Rachel', 'Megan',
  'Nicole', 'Michelle', 'Rebecca', 'Danielle', 'Christine', 'Andrea', 'Marie',
  // Asked for by name.
  'Kate', 'Maria', 'Sandra', 'Lisa', 'Mavi',
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
  // Common in the US. Same word rule, which costs a lot of popular ones here:
  // Jack, Mason, Hunter, Cooper, Parker, Carter, Brooks, Miles, Angel, Roman,
  // Christian and Maverick are all excluded as ordinary words or occupations.
  'Liam', 'Noah', 'Elijah', 'James', 'William', 'Benjamin', 'Lucas', 'Henry',
  'Alexander', 'Michael', 'Ethan', 'Jacob', 'Logan', 'Jackson', 'Sebastian',
  'Owen', 'Theodore', 'Samuel', 'Joseph', 'David', 'Wyatt', 'Matthew', 'Luke',
  'Julian', 'Gabriel', 'Isaac', 'Lincoln', 'Anthony', 'Dylan', 'Charles',
  'Andrew', 'Nathan', 'Caleb', 'Adrian', 'Nolan', 'Cameron', 'Connor',
  'Nicholas', 'Dominic', 'Evan',
  // The people who built this thing, and Stan's dad.
  'Stan', 'Seth', 'Vern',
  // Asked for by name. Two of these bend rule 1 and are in anyway, on request:
  // "Bob" is also a verb (bob up and down) and a haircut, and "John" is also a
  // toilet — both will false-wake occasionally. They are common enough as names
  // that the trade is worth making, but it IS a trade, not an oversight.
  'Trevor', 'Jeff', 'Steve', 'John', 'Jordan', 'Alex', 'Chris', 'Joshua',
  'Robert', 'Bob', 'Fabian', 'Peter', 'Kenny',
];

// Famous robots, computers and AIs. A bot named after one is a small joke that
// lands immediately, and unlike the two lists above these carry no gender, so
// they sit outside the even split rather than tipping it.
//
// Rule 1 still applies. Rule 2 turned out to be over-strict here, and the list
// below reflects a real test call rather than a guess about what Google can hear:
//
//     "When I talk about the robot C-3PO, how does that get transcribed?
//      What about R2D2? ... And you know, Wally, that's a little harder."
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
//   Bender, Data, Ash, Zen  ordinary words — "on a bender", "the data says"
//   Vision, Friday, Colossus, Bumblebee, Tars, Holly    likewise
//
//   Alexa, Siri             EXCLUDED FOR A DIFFERENT AND BETTER REASON: the bot
//                           says its own name aloud, in a room full of phones and
//                           speakers. A bot introducing itself would set off every
//                           assistant within earshot. Cortana is here because it
//                           is discontinued and wakes nothing.
const ROBOTIC = [
  // Film
  'Hal', 'Tron', 'Robby', 'Gort', 'Wally', 'Megatron', 'Jarvis', 'Ultron',
  'Baymax', 'Chappie', 'Robocop', 'Skynet', 'Pris', 'Astro', 'Talos', 'Terminator',
  // Film — confirmed intact through Google's captions on a live test call
  'R2D2', 'C-3PO',
  // Film — the two-word ones, safer than either word on its own
  'Optimus Prime', 'Iron Giant', 'Johnny Five',
  // Television
  'Twiki', 'Kryten', 'Marvin', 'Rosie', 'Vicki', 'Ziggy', 'Orac', 'Maeve', 'Dolores',
  'Bernard', 'Roy',
  // Books
  'Daneel', 'Giskard', 'Multivac', 'Wintermute', 'Deep Thought',
  // Real, or real enough
  'Eliza', 'Watson', 'Turing', 'Clippy', 'Cortana',
  // SoftBank's Pepper, and one of this project's own bots. The single knowing
  // exception to rule 1 — "pass the pepper" will occasionally false-wake it —
  // kept because it is already a bot here and the trade was made with open eyes.
  'Pepper',
];

const BOT_NAMES = [...FEMININE, ...MASCULINE, ...ROBOTIC];

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

module.exports = { BOT_NAMES, FEMININE, MASCULINE, ROBOTIC, randomBotName };
