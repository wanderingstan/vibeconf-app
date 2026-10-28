// preload-google-sign-in.js — the bot's Google sign-in window (openBotSignInWindow).
//
// Only job: make navigator.userAgentData agree with the Chrome identity main
// sets on the session (string + Sec-CH-UA* headers), before Google's scripts
// read it. Google refuses a sign-in from what looks like an embedded browser
// ("This browser or app may not be secure", #499). Exposes nothing to the page.
require('./slack-ua').installClientHintsShim();
