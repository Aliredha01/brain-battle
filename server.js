const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
app.use(express.static(path.join(__dirname, 'public')));
const rooms = new Map();
const baseQuestions = require('./questions.json');
const clone = x => JSON.parse(JSON.stringify(x));
const code = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const QUESTION_SECONDS = 60, ANSWER_SECONDS = 10, NO_ANSWER_PENALTY = 25;

// Optional PostgreSQL persistence. Set DATABASE_URL on Render to retain custom question packs and game history.
let pool = null;
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } });
  }
} catch (e) { console.error('PostgreSQL setup unavailable:', e.message); }
async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS brain_battle_settings (setting_key TEXT PRIMARY KEY, setting_value JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS brain_battle_history (id BIGSERIAL PRIMARY KEY, room_code TEXT NOT NULL, played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), result JSONB NOT NULL)`);
}
async function loadQuestionBank() {
  if (!pool) return clone(baseQuestions);
  const { rows } = await pool.query(`SELECT setting_value FROM brain_battle_settings WHERE setting_key='question_bank'`);
  return rows[0]?.setting_value || clone(baseQuestions);
}
async function saveQuestionBank(bank) {
  if (!pool) return;
  await pool.query(`INSERT INTO brain_battle_settings(setting_key,setting_value) VALUES('question_bank',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`, [JSON.stringify(bank)]);
}
async function saveHistory(room) {
  if (!pool) return;
  const result = { code: room.code, teams: room.teams, scores: room.scores, players: room.players.map(p => ({ name: p.name, team: p.team })), rounds: room.rounds, winner: [...room.teams].sort((a,b)=>(room.scores[b.id]||0)-(room.scores[a.id]||0))[0]?.name };
  await pool.query(`INSERT INTO brain_battle_history(room_code,result) VALUES($1,$2::jsonb)`, [room.code, JSON.stringify(result)]);
}
function publicState(r) {
  return { code:r.code, teams:r.teams, players:r.players.map(p=>({id:p.id,name:p.name,team:p.team})), board:r.board, category:r.category, question:r.question, questionIndex:r.questionIndex, buzzed:r.buzzed, answer:r.answer, phase:r.phase, scores:r.scores, categoryPickerTeam:r.categoryPickerTeam, selectedCategory:r.selectedCategory, categories:Object.keys(r.questions), questions:r.questions, deadline:r.deadline, answerDeadline:r.answerDeadline, remainingMs:r.remainingMs, allowedTeam:r.allowedTeam, attemptedTeams:r.attemptedTeams, roundMessage:r.roundMessage, hostId:r.host, rounds:r.rounds };
}
function emit(r) { io.to(r.code).emit('state', publicState(r)); }
function err(s,m) { s.emit('errorMsg',m); }
function cleanName(s, fallback='Player') { return String(s||'').trim().slice(0,24)||fallback; }
function clearTimers(r) { if(r.questionTimer) clearTimeout(r.questionTimer); if(r.answerTimer) clearTimeout(r.answerTimer); r.questionTimer=null; r.answerTimer=null; r.deadline=null; r.answerDeadline=null; }
function availableTeams(r) { return r.teams.filter(t => r.players.some(p=>p.team===t.id)); }
function nextTeam(r, fromTeam) {
  const active = availableTeams(r).map(t=>t.id);
  if (!active.length) return null;
  for (let step=1; step<=r.teams.length; step++) { const id=(fromTeam+step)%r.teams.length; if(active.includes(id) && !r.attemptedTeams.includes(id)) return id; }
  return null;
}
function finishRound(r, reason) {
  clearTimers(r); r.phase='reveal'; r.roundMessage=reason; r.answer=r.answer||{correct:false, selected:'', correctAnswer:r.question.answer, explanation:r.question.explanation||''};
  r.board[r.category][r.questionIndex]=true; r.categoryPickerTeam=null; r.rounds.push({category:r.category,question:r.question.text,points:r.question.points,correctTeam:null,reason}); emit(r);
}
function correctRound(r, choice) {
  clearTimers(r); const team=r.buzzed.team; r.scores[team]+=(r.question.points||100); r.answer={correct:true,selected:choice,correctAnswer:r.question.answer,explanation:r.question.explanation||''}; r.board[r.category][r.questionIndex]=true; r.categoryPickerTeam=team; r.phase='reveal'; r.roundMessage=`${r.buzzed.teamName} answered correctly and earned ${r.question.points||100} points.`;
  r.rounds.push({category:r.category,question:r.question.text,points:r.question.points,correctTeam:r.teams.find(t=>t.id===team)?.name,answer:choice}); emit(r);
}
function resumeQuestionTimer(r) {
  if (r.remainingMs <= 0) return finishRound(r, 'The 60-second question timer expired.');
  r.deadline = Date.now() + r.remainingMs;
  const token = r.deadline;
  r.questionTimer = setTimeout(() => { if (rooms.get(r.code) === r && r.phase === 'question' && r.deadline === token) finishRound(r, 'The 60-second question timer expired.'); }, r.remainingMs);
}
function moveToNextTeam(r, message) {
  const previous=r.buzzed?.team; if(previous!==undefined && !r.attemptedTeams.includes(previous)) r.attemptedTeams.push(previous);
  const next=nextTeam(r, previous ?? -1);
  r.buzzed=null; r.answer=null; r.answerDeadline=null;
  if(next===null || r.remainingMs <= 0) return finishRound(r, message+' No eligible teams remain; no points awarded.');
  r.allowedTeam=next; r.phase='question'; r.roundMessage=message+` ${r.teams.find(t=>t.id===next).name} is next.`; resumeQuestionTimer(r); emit(r);
}
function makeRoomState(c, hostId, teamCount, questions) {
  const teams=Array.from({length:Math.max(2,Math.min(8,+teamCount||8))},(_,i)=>({id:i,name:`Team ${i+1}`,color:['#6d8cff','#ff6b8a','#4de0d0','#ffd166','#b28cff','#ff9f5a','#65c18c','#e879f9'][i]}));
  const scores=Object.fromEntries(teams.map(t=>[t.id,0]));
  const board=Object.fromEntries(Object.entries(questions).map(([cat,qs])=>[cat,qs.map(()=>false)]));
  return {code:c,host:hostId,teams,players:[],scores,board,questions,category:null,question:null,questionIndex:null,buzzed:null,answer:null,phase:'lobby',categoryPickerTeam:null,selectedCategory:null,questionTimer:null,answerTimer:null,deadline:null,answerDeadline:null,remainingMs:0,allowedTeam:null,attemptedTeams:[],roundMessage:'',rounds:[]};
}
io.on('connection', socket => {
  socket.on('roomInfo', ({code:roomCode})=>{const r=rooms.get(String(roomCode||'').toUpperCase());if(r)socket.emit('roomInfo',{teams:r.teams,phase:r.phase});});
  socket.on('create', async ({teamCount=8}={}) => {
    try { const questions=await loadQuestionBank(); let c=code(); while(rooms.has(c)) c=code(); const r=makeRoomState(c,socket.id,teamCount,questions); rooms.set(c,r); socket.join(c); socket.data.room=c; socket.data.role='host'; socket.emit('created',{code:c}); emit(r); }
    catch(e){console.error(e);err(socket,'Could not create the game. Please try again.');}
  });
  socket.on('join', ({code:roomCode,name,team}) => {
    const r=rooms.get(String(roomCode||'').toUpperCase()); if(!r)return err(socket,'Room not found.'); if(r.phase!=='lobby')return err(socket,'This game has already started.');
    if(!r.teams.some(t=>t.id===+team))return err(socket,'Choose a valid team.');
    const p={id:socket.id,name:cleanName(name),team:+team}; r.players.push(p); socket.join(r.code); socket.data.room=r.code; socket.data.role='player'; socket.data.team=p.team; emit(r);
  });
  socket.on('renameTeam', ({team,name,color})=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=='lobby')return;const t=r.teams.find(t=>t.id===+team);if(!t)return;t.name=cleanName(name,`Team ${t.id+1}`);if(/^#[0-9a-fA-F]{6}$/.test(String(color||'')))t.color=color;emit(r);});
  socket.on('start',()=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=='lobby')return;if(!r.players.length)return err(socket,'At least one player must join before starting.');r.phase='board';emit(r);});
  socket.on('choose',({category,index})=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=='board')return;if(!r.questions[category]||!Number.isInteger(+index)||+index<0||+index>=r.questions[category].length||r.board[category][+index]||(r.selectedCategory&&category!==r.selectedCategory))return;
    r.category=category;r.questionIndex=+index;r.question=r.questions[category][+index];r.selectedCategory=null;r.buzzed=null;r.answer=null;r.allowedTeam=null;r.attemptedTeams=[];r.roundMessage='All teams may buzz in.';r.phase='question';r.remainingMs=QUESTION_SECONDS*1000; resumeQuestionTimer(r); emit(r);
  });
  socket.on('buzz',()=>{const r=rooms.get(socket.data.room);if(!r||r.phase!=='question'||r.buzzed||Date.now()>=r.deadline)return;const p=r.players.find(x=>x.id===socket.id);if(!p)return;if(r.allowedTeam!==null&&p.team!==r.allowedTeam)return;if(r.attemptedTeams.includes(p.team))return;
    r.remainingMs=Math.max(0,r.deadline-Date.now());if(r.questionTimer)clearTimeout(r.questionTimer);r.questionTimer=null;r.deadline=null;r.buzzed={player:p.name,playerId:p.id,team:p.team,teamName:r.teams.find(t=>t.id===p.team).name};r.phase='answering';r.answerDeadline=Date.now()+ANSWER_SECONDS*1000;const token=r.answerDeadline;
    r.answerTimer=setTimeout(()=>{if(rooms.get(r.code)===r&&r.phase==='answering'&&r.answerDeadline===token){r.scores[p.team]-=NO_ANSWER_PENALTY;moveToNextTeam(r,`${p.name} did not answer within 10 seconds. ${r.teams.find(t=>t.id===p.team).name} loses ${NO_ANSWER_PENALTY} points.`);}},Math.max(0,r.answerDeadline-Date.now()));emit(r);
  });
  socket.on('submitAnswer',({choice})=>{const r=rooms.get(socket.data.room);if(!r||r.phase!=='answering'||!r.buzzed||r.buzzed.playerId!==socket.id)return;if(Date.now()>r.answerDeadline)return;const selected=String(choice||'');if(selected===r.question.answer){correctRound(r,selected);}else{r.answer={correct:false,selected,correctAnswer:r.question.answer,explanation:r.question.explanation||''};clearTimeout(r.answerTimer);r.answerTimer=null;moveToNextTeam(r,`${r.buzzed.teamName} answered incorrectly. The next team to the right gets a chance.`);}
  });
  socket.on('pickCategory',({category})=>{const r=rooms.get(socket.data.room);if(!r||r.phase!=='pickCategory'||!r.players.some(p=>p.id===socket.id&&p.team===r.categoryPickerTeam))return;if(!r.questions[category]||r.board[category].every(Boolean))return;r.selectedCategory=category;r.categoryPickerTeam=null;r.phase='board';emit(r);});
  socket.on('next',()=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=='reveal')return;r.category=null;r.question=null;r.questionIndex=null;r.buzzed=null;r.answer=null;r.allowedTeam=null;r.attemptedTeams=[];if(Object.values(r.board).every(levels=>levels.every(Boolean))){r.phase='finished';saveHistory(r).catch(console.error);}else{r.phase=r.categoryPickerTeam!==null?'pickCategory':'board';}r.selectedCategory=null;emit(r);});
  socket.on('finish',async()=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||!['board','pickCategory'].includes(r.phase))return;r.phase='finished';try{await saveHistory(r);}catch(e){console.error(e);}emit(r);});
  socket.on('updateQuestion',async({category,index,question})=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||!['lobby','board'].includes(r.phase))return;if(!r.questions[category]||index<0||index>=r.questions[category].length||r.board[category][index])return;const q={text:String(question.text||'').slice(0,400),options:(question.options||[]).slice(0,4).map(x=>String(x).slice(0,100)),answer:String(question.answer||''),explanation:String(question.explanation||'').slice(0,500),points:(index+1)*100};if(!q.text||q.options.length!==4||q.options.some(x=>!x)||!q.options.includes(q.answer))return err(socket,'Enter a question, four choices, and choose the correct answer from those choices.');r.questions[category][index]=q;try{await saveQuestionBank(r.questions);}catch(e){console.error(e);}emit(r);socket.emit('savedQuestion',{category,index});});
  socket.on('addCategory',async({category})=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||!['lobby','board'].includes(r.phase))return;const name=cleanName(category,'').trim();if(!name||r.questions[name])return err(socket,'Enter a new category name.');r.questions[name]=[];r.board[name]=[];try{await saveQuestionBank(r.questions);}catch(e){console.error(e);}emit(r);socket.emit('savedQuestion',{category:name,index:0});});
  socket.on('addQuestion',async({category,question})=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||!['lobby','board'].includes(r.phase))return;if(!r.questions[category])return err(socket,'Choose a valid category.');const opts=(question.options||[]).slice(0,4).map(x=>String(x).slice(0,100));if(!String(question.text||'').trim()||opts.length!==4||opts.some(x=>!x)||!opts.includes(String(question.answer||'')))return err(socket,'Enter a question, four choices, and choose the correct answer.');const q={text:String(question.text).slice(0,400),options:opts,answer:String(question.answer),explanation:String(question.explanation||'').slice(0,500),points:(r.questions[category].length+1)*100};r.questions[category].push(q);r.board[category].push(false);try{await saveQuestionBank(r.questions);}catch(e){console.error(e);}emit(r);socket.emit('savedQuestion',{category,index:r.questions[category].length-1});});
  socket.on('history',async()=>{if(!pool)return socket.emit('historyResult',[]);try{const {rows}=await pool.query('SELECT result,played_at FROM brain_battle_history ORDER BY played_at DESC LIMIT 20');socket.emit('historyResult',rows.map(x=>({...x.result,playedAt:x.played_at})));}catch(e){err(socket,'Could not load game history.');}});
  socket.on('disconnect',()=>{const r=rooms.get(socket.data.room);if(!r)return;if(r.host===socket.id){clearTimers(r);io.to(r.code).emit('closed');rooms.delete(r.code);}else{r.players=r.players.filter(p=>p.id!==socket.id);emit(r);}});
});
(async()=>{try{await initDb();const port=process.env.PORT||3000;server.listen(port,'0.0.0.0',()=>console.log(`Brain Battle running on ${port}`));}catch(e){console.error('Database initialization failed:',e);process.exit(1);}})();
