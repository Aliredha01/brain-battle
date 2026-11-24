# Brain Battle Trivia (v2)

A multiplayer trivia game for up to 8 teams. The host runs the game and players join from phones using the room code or QR link.

## Run locally

1. Install Node.js LTS.
2. In this folder run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

For phone testing on the same Wi-Fi, open `http://YOUR-COMPUTER-IP:3000/?room=ROOMCODE` on the phone. Do not use `localhost` on the phone.

## Render deployment

Create a Render **Web Service** connected to the GitHub repository.

- Build command: `npm install`
- Start command: `npm start`
- Root directory: blank if `package.json` is at the repository root.

Commit/push updated project files to GitHub. Render can automatically deploy the latest commit; the public URL stays the same.

## Game rules

- The host must click Start Game. Players wait in the lobby until then.
- Only the host chooses questions and advances rounds.
- Each question has a 60-second overall round timer.
- Any team may buzz first. After an incorrect answer or a missed 10-second answer window, the next active team clockwise gets the next chance on the same question.
- A player who buzzes has 10 seconds to answer. If they do not answer, their team loses 25 points.
- A wrong answer does not award points and passes the chance to the next team. If the round expires or all eligible teams have tried without a correct answer, no team receives the question points.
- A correct answer earns the question's points. After the host clicks Next, a player on the winning team chooses the next category.
- Questions do not automatically advance. The host clicks Next after the round result is shown.

## Persistence

The game works without a database, but rooms and scores are in memory and are lost when the server restarts. Custom question edits are also only saved for the lifetime of the server unless PostgreSQL is configured.

To retain custom question packs and game history across deployments/restarts on Render:

1. Create a PostgreSQL database in Render.
2. Copy its **Internal Database URL** (or External URL if needed).
3. In the Brain Battle Web Service, open **Environment** and add `DATABASE_URL` with that connection string.
4. Save changes and redeploy. The app creates its tables automatically.

PostgreSQL stores the shared custom question bank and finished game history. Live rooms, active scores, and in-progress rounds remain in server memory; use a paid persistent architecture/Redis-backed session store if you need active rooms to survive service restarts or multiple server instances.

## Security and operations

This is a starter project for private game nights. Anyone with a room code can join while the lobby is open. Do not put private or sensitive data in player names or questions. For a public production service, add host authentication, room access controls, rate limits, and database backups.
