// Put a bot in a call: it says hello, prints what it hears and reads, and leaves.
//   npm install @vibeconferencing/calls playwright-core
//   node hello-call.js <meeting link> [clip.mp3]

const path = require('path');
const { join, JoinError } = require('@vibeconferencing/calls');

async function main([link, clip = path.join(__dirname, 'hello.mp3')]) {
  const call = await join(link, {
    name: 'Hello Bot (AI)',
    profile: process.env.HELLO_PROFILE || path.join(__dirname, '.profile'),
    onState: (state) => console.log('state:', state),
  });

  call.on('caption', (turn) => { if (turn.final) console.log(`${turn.speaker}: ${turn.text}`); });
  call.on('chat', (msg) => console.log(`[chat] ${msg.sender}: ${msg.text}`));

  const playback = await call.speak(clip);
  await playback.done;
  await call.chat.send('Hi, I am a bot. I leave in 30 seconds.');
  await new Promise((resolve) => setTimeout(resolve, 30000));
  await call.leave();
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof JoinError ? `Couldn't join (${err.code}): ${err.message}` : err);
  process.exit(1);
});
