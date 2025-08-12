import { createClient } from '@deepgram/sdk';
import { spawn } from 'child_process';

console.log('🎯 AUDIO FLOW TEST SCRIPT');
console.log('========================\n');

// Your API key
const DEEPGRAM_API_KEY = '9b8e595521a414c7caa7e6ef88a3afe6fcb7fffa';

console.log('1️⃣ Testing Deepgram connection...');
const deepgram = createClient(DEEPGRAM_API_KEY);

const connection = deepgram.listen.live({
  model: 'nova-3',
  language: 'en-US',
  smart_format: true,
  encoding: 'linear16',
  sample_rate: 16000,
  channels: 2,
  multichannel: true,
});

let chunksReceived = 0;
let transcriptsReceived = 0;

connection.on('open', () => {
  console.log('✅ Deepgram connected!\n');
  console.log('2️⃣ Capturing audio from microphone...');
  
  // Use sox to capture audio from microphone
  // macOS: brew install sox
  const sox = spawn('sox', [
    '-d',                    // default input device (microphone)
    '-r', '16000',          // sample rate
    '-c', '2',              // stereo
    '-e', 'signed-integer', // encoding
    '-b', '16',             // bits
    '-t', 'raw',            // raw output
    '-'                     // output to stdout
  ]);

  sox.stdout.on('data', (chunk) => {
    chunksReceived++;
    if (chunksReceived % 100 === 0) {
      console.log(`📊 Sent ${chunksReceived} chunks to Deepgram...`);
    }
    connection.send(chunk);
  });

  sox.stderr.on('data', (data) => {
    // Sox outputs info to stderr, ignore it
  });

  sox.on('error', (err) => {
    console.error('❌ Sox error:', err);
    console.log('\n⚠️  Make sure sox is installed: brew install sox');
  });

  console.log('🎤 SPEAK NOW! Say something...\n');
});

connection.on('transcript', (data) => {
  const alt = data.channel?.alternatives?.[0];
  if (alt?.transcript) {
    transcriptsReceived++;
    console.log(`\n✅ TRANSCRIPT #${transcriptsReceived}:`);
    console.log(`   Channel: ${data.channel_index?.[0] || 0}`);
    console.log(`   Final: ${data.is_final}`);
    console.log(`   Text: "${alt.transcript}"`);
  }
});

connection.on('error', (err) => {
  console.error('❌ Deepgram error:', err);
});

connection.on('close', () => {
  console.log('Connection closed');
  process.exit(0);
});

// Exit on Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n📊 SUMMARY:');
  console.log(`   Audio chunks sent: ${chunksReceived}`);
  console.log(`   Transcripts received: ${transcriptsReceived}`);
  
  if (chunksReceived > 0 && transcriptsReceived === 0) {
    console.log('\n❌ PROBLEM: Audio was sent but no transcripts received!');
    console.log('   Possible issues:');
    console.log('   - Audio format mismatch');
    console.log('   - Silence/noise threshold');
    console.log('   - API quota exceeded');
  } else if (transcriptsReceived > 0) {
    console.log('\n✅ SUCCESS: Deepgram is working correctly!');
  }
  
  connection.finish();
  process.exit(0);
});

setTimeout(() => {
  console.log('\n⏰ Test timeout after 30 seconds');
  process.exit(0);
}, 30000); 