const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const app = express(), server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname,"public")));
const rooms = new Map();
const questionBank = require("./questions.json");
const code = () => Math.random().toString(36).slice(2,6).toUpperCase();
const clone = x => JSON.parse(JSON.stringify(x));
function publicState(r){return {code:r.code,teams:r.teams,players:r.players.map(p=>({id:p.id,name:p.name,team:p.team})),board:r.board,category:r.category,question:r.question,questionIndex:r.questionIndex,buzzed:r.buzzed,answer:r.answer,phase:r.phase,scores:r.scores,categoryPickerTeam:r.categoryPickerTeam,selectedCategory:r.selectedCategory,categories:Object.keys(r.questions),questions:r.questions,deadline:r.deadline,hostId:r.host};}
function emit(r){io.to(r.code).emit("state",publicState(r));}
function cleanName(s){return String(s||"").trim().slice(0,22)||"Player";}
function clearTimer(r){if(r.timer){clearTimeout(r.timer);r.timer=null;}r.deadline=null;}
function reveal(r,correct,selected=""){clearTimer(r);if(correct&&r.buzzed)r.scores[r.buzzed.team]+=(r.question.points||((r.questionIndex+1)*100));r.answer={correct,selected,correctAnswer:r.question.answer,explanation:r.question.explanation||""};r.board[r.category][r.questionIndex]=true;r.categoryPickerTeam=correct&&r.buzzed?r.buzzed.team:null;r.phase="reveal";emit(r);}
function allDone(r){return Object.values(r.board).every(levels=>levels.every(Boolean));}
io.on("connection",socket=>{
 socket.on("create",({teamCount=8}={})=>{let c=code();while(rooms.has(c))c=code();const qs=clone(questionBank);const r={code:c,host:socket.id,teams:Array.from({length:Math.max(2,Math.min(8,+teamCount||8))},(_,i)=>({id:i,name:`Team ${i+1}`})),players:[],scores:{},board:{},questions:qs,category:null,question:null,questionIndex:null,buzzed:null,answer:null,phase:"lobby",categoryPickerTeam:null,selectedCategory:null,timer:null,deadline:null};r.teams.forEach(t=>r.scores[t.id]=0);Object.keys(qs).forEach(cat=>r.board[cat]=qs[cat].map(()=>false));rooms.set(c,r);socket.join(c);socket.data.room=c;socket.emit("created",{code:c});emit(r);});
 socket.on("join",({code,name,team})=>{const r=rooms.get(String(code||"").toUpperCase());if(!r)return socket.emit("errorMsg","Room not found.");if(r.phase!=="lobby")return socket.emit("errorMsg","This game has already started.");if(!r.teams.some(t=>t.id===+team))return socket.emit("errorMsg","Choose a valid team.");const p={id:socket.id,name:cleanName(name),team:+team};r.players.push(p);socket.join(r.code);socket.data.room=r.code;emit(r);});
 socket.on("start",()=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=="lobby")return;r.phase="board";emit(r);});
 socket.on("choose",({category,index})=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=="board")return;if(!r.questions[category]||index<0||index>=r.questions[category].length||r.board[category][index]||(r.selectedCategory&&category!==r.selectedCategory))return;r.category=category;r.questionIndex=index;r.question=r.questions[category][index];r.selectedCategory=null;r.buzzed=null;r.answer=null;r.phase="question";r.deadline=Date.now()+15000;const token=`${r.category}:${index}:${r.deadline}`;r.timer=setTimeout(()=>{if(rooms.get(r.code)===r&&(r.phase==="question"||r.phase==="answering")&&`${r.category}:${r.questionIndex}:${r.deadline}`===token)reveal(r,false,"TIME EXPIRED");},15000);emit(r);});
 socket.on("buzz",()=>{const r=rooms.get(socket.data.room);if(!r||r.phase!=="question"||r.buzzed)return;const p=r.players.find(x=>x.id===socket.id);if(!p)return;r.buzzed={player:p.name,playerId:p.id,team:p.team,teamName:r.teams.find(t=>t.id===p.team).name};r.phase="answering";emit(r);});
 socket.on("submitAnswer",({choice})=>{const r=rooms.get(socket.data.room);if(!r||r.phase!=="answering"||!r.buzzed||r.buzzed.playerId!==socket.id)return;const chosen=String(choice||"");reveal(r,chosen===r.question.answer,chosen);});
 socket.on("pickCategory",({category})=>{const r=rooms.get(socket.data.room);if(!r||r.phase!=="pickCategory"||!r.players.some(p=>p.id===socket.id&&p.team===r.categoryPickerTeam))return;if(!r.questions[category]||r.board[category].every(Boolean))return;r.selectedCategory=category;r.categoryPickerTeam=null;r.phase="board";emit(r);});
 socket.on("next",()=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||r.phase!=="reveal")return;r.category=null;r.question=null;r.questionIndex=null;r.buzzed=null;r.answer=null;if(allDone(r)){r.phase="finished";}else{r.phase=r.categoryPickerTeam!==null?"pickCategory":"board";}r.selectedCategory=null;emit(r);});
 socket.on("finish",()=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||!['board','pickCategory'].includes(r.phase))return;r.phase="finished";emit(r);});
 socket.on("updateQuestion",({category,index,question})=>{const r=rooms.get(socket.data.room);if(!r||r.host!==socket.id||!['lobby','board'].includes(r.phase))return;if(!r.questions[category]||index<0||index>=r.questions[category].length||r.board[category][index])return;const q={text:String(question.text||"").slice(0,400),options:(question.options||[]).slice(0,4).map(x=>String(x).slice(0,100)),answer:String(question.answer||""),explanation:String(question.explanation||"").slice(0,500),points:(index+1)*100};if(!q.text||q.options.length!==4||q.options.some(x=>!x)||!q.options.includes(q.answer))return socket.emit("errorMsg","Enter a question, four choices, and choose the correct answer from those choices.");r.questions[category][index]=q;r.questionBankEdited=true;emit(r);socket.emit("savedQuestion",{category,index});});
 socket.on("disconnect",()=>{const c=socket.data.room,r=rooms.get(c);if(!r)return;if(r.host===socket.id){clearTimer(r);io.to(c).emit("closed");rooms.delete(c);}else{r.players=r.players.filter(p=>p.id!==socket.id);emit(r);}});
});
const port=process.env.PORT||3000;server.listen(port,"0.0.0.0",()=>console.log(`Brain Battle running on ${port}`));
