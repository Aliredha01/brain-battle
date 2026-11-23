# Brain Battle — upgraded multiplayer trivia starter

## Features
- Real-time rooms with up to 8 teams; friends join from phones using a room code or QR code.
- 15 categories with 5 questions each (75 questions), worth 100–500 points.
- First player to buzz gets 15 seconds to choose an answer on their phone.
- Server checks answers automatically; correct answers earn points and let that team choose the next category.
- Animated live scoreboard, sound cues, countdown bar, confetti and champion screen.
- Host question editor: customize any unused question's wording, four choices, answer and explanation.
- Host can end the game early to reveal the standings.
- Responsive phone and desktop layout.

## Run locally
Requires Node.js 18 or newer. In this folder run:

```bash
npm install
npm start
```

Open http://localhost:3000.

## Let friends join from anywhere
Deploy this folder to a Node-compatible hosting service that supports persistent WebSocket connections (for example Render, Railway, or a VPS). Set the start command to `npm start`, then share the HTTPS URL and room code. Static-only hosting is not sufficient. The QR code encodes the join URL with the room code.

## Notes and limitations
- Rooms, scores, and edited questions are held in server memory and reset if the server restarts.
- Sound effects use the browser's Web Audio API and may start only after a user interaction, depending on browser settings.
- The QR generator loads from a public CDN; if blocked, the room code and join link remain available.
- This is a starter project, not a deployed public website.
