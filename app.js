const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);



app.use(express.static(__dirname));

let globalMatchmakingQueue = [];
let activeMatches = [];

let currentRoom = null;

const DISCONNECT_GRACE_MS = 8000;


/* ---------------- ROUTES ---------------- */

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/Create', (req, res) => {
    res.sendFile(__dirname + '/Creat_args.html');
});

app.get('/dueal', (req, res) => {
    res.sendFile(__dirname + '/dueal.html');
});

app.get('/live', (req, res) => {
    res.sendFile(__dirname + '/live.html');
});

// you_are_spectator
app.get('/Sigh-in', (req, res) => {
    res.sendFile(__dirname + '/Sigh-in.html');
});

app.get('/Invite', (req, res) => {

    res.sendFile(__dirname + '/Invite.html');

});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/past-matches', async (req, res) => {
    const { data, error } = await supabase
        .from('past_matches')
        .select('*')
        .order('ended_at', { ascending: false })
        .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get('/past-matches/:roomId/arguments', async (req, res) => {
    const { data, error } = await supabase
        .from('past_arguments')
        .select('*')
        .eq('room_id', req.params.roomId)
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get('/replay', (req, res) => {
    res.sendFile(__dirname + '/replay.html');
});



// Put this ABOVE io.on('connection')

function broadcastLiveMatches() {
    const liveList = activeMatches.map(m => ({
        roomId: m.roomId,
        thesis: m.thesis,
        spectatorCount: m.spectators.length
    }));
    io.emit('update_live_matches', liveList);
}

async function archiveMatch(match, endReason, winnerRole = null) {
    const { error } = await supabase
        .from('past_matches')
        .update({
            ended_at: new Date().toISOString(),
            end_reason: endReason,
            winner_role: winnerRole
        })
        .eq('room_id', match.roomId);

    if (error) console.error('Failed to archive match:', error);
}


// activeMatches

io.on('connection', (socket) => { //wen a new user is connceted run this 

    console.log(`Connected: ${socket.id}`);

    broadcastLiveMatches();


    socket.emit( //gives out the subject and the content 
        'update_duel_list',
        globalMatchmakingQueue //sends the user the current duels then the html takes that to show them te beautifull btutton
    );

    socket.on('join_queue', (data) => {

        if (
            !data || //the  mode and theses
            !data.thesis ||
            typeof data.thesis !== 'string'
        ) {
            return;
        }

        const thesis = data.thesis.trim();

        if (thesis.length === 0) {
            return;
        }
        


        // socket.emit("macth_info", (data) => {
        //     thesis
        // })

        const newMatch = { //when a new duel has been created 
            id: crypto.randomUUID(),
            thesis,
            startTime: Date.now(),
            socketId: socket.id
        };


// send_argument

        globalMatchmakingQueue.push(newMatch); //puts the new duel into the globalmacthmakingqueue

        console.log(
            `New duel created: ${newMatch.thesis}`
        );

        io.emit(
            'update_duel_list',
            globalMatchmakingQueue
        );
    });


    socket.on('join_match', (data) => { //macthID : macthID 

        if (!data || !data.matchId) {
            return;
        }

        const index =
            globalMatchmakingQueue.findIndex(
                duel => duel.id === data.matchId
            );

        if (index === -1) {

            socket.emit('match_error', {
                message:
                    'This duel has already been claimed.'
            });

            return;
        }

        // executeAutomaticTimeout

        const duel =
            globalMatchmakingQueue[index];

        globalMatchmakingQueue.splice(index, 1);

        const roomId = `room_${duel.id}`;

        socket.join(roomId);

        const creatorSocket =
            io.sockets.sockets.get(
                duel.socketId
            );

        if (creatorSocket) {
            creatorSocket.join(roomId);
        }

        activeMatches.push({
            roomId,
            thesis: duel.thesis,
            creatorSocketId: duel.socketId,
            challengerSocketId: socket.id,
            spectators: [],
            createdAt: Date.now(),

            pendingDisconnect: {           // ADD THIS
                creator: null,
                challenger: null
            }
        });

        supabase.from('past_matches').insert({

            room_id: roomId,
            thesis: duel.thesis,
            creator_socket_id: duel.socketId,
            challenger_socket_id: socket.id,
            started_at: new Date().toISOString()

        }).then(({ error }) => {
            if (error) console.error('Failed to create match record:', error);

        });


    

        broadcastLiveMatches();

        io.to(duel.socketId).emit(
            'match_found',
            {
                matchId: roomId,
                role: 'creator'
            }
        );

        socket.emit(
            'match_found',

            {
                matchId: roomId,
                role: 'challenger'
            }
        );

        io.emit(
            'update_duel_list',
            globalMatchmakingQueue
        );

        console.log(
            `Match started: ${roomId}`
        );
    });
// activeMatches
    socket.on('join_room', (data) => {

        const roomId = typeof data === 'string' ? data : data?.roomId;
        const role = typeof data === 'string' ? null : data?.role;


        if (!roomId) return;

        socket.join(roomId);

        const match = activeMatches.find(m => m.roomId === roomId);

        if (!match) {
            socket.emit('match_error', { message: 'This match no longer exists.' });
            return;
        }

        if (role === 'creator') {
            match.creatorSocketId = socket.id;
            if (match.pendingDisconnect.creator) {
                clearTimeout(match.pendingDisconnect.creator);
                match.pendingDisconnect.creator = null;
            }

        } else if (role === 'challenger') {

            match.challengerSocketId = socket.id;

            if (match.pendingDisconnect.challenger) {

                clearTimeout(match.pendingDisconnect.challenger);

                match.pendingDisconnect.challenger = null;

            }
        } else {

            const isPlayer = match.creatorSocketId === socket.id || match.challengerSocketId === socket.id;
            if (!isPlayer) {

                match.spectators.push(socket.id);

                socket.emit('you_are_spectator');

                broadcastLiveMatches();

            }
        }

        socket.emit('macth_info', { thesis: match.thesis });

    });



    // 2. Listen for 'send_argument' from your frontend Send button
    socket.on('send_argument', (data) => {

        console.log(`Message received for room ${data.roomId}: ${data.message}`);

        const match = activeMatches.find(m => m.roomId === data.roomId);

        let senderRole = null;

        if (match) {

            if (socket.id === match.creatorSocketId) senderRole = 'creator';

            else if (socket.id === match.challengerSocketId) senderRole = 'challenger';

        }



        // 3. Broadcast 'new_argument' back down to EVERYONE inside that specific room
        
        io.to(data.roomId).emit('new_argument', {
            message: data.message,
            senderId: socket.id,
            senderRole: senderRole
        });

        supabase.from('past_arguments').insert({
            room_id: data.roomId,
            sender_role: senderRole,
            message: data.message

        }).then(({ error }) => {

            if (error) console.error('Failed to save argument:', error);


        });

    });

    // Global memory object to keep track of running intervals for each room
    const matchTimers = {}; 

    function startTurnTimeoutClock(roomId, activePlayerSocketId, totalMatchEndTime) {
        // 1. Clear any running clock for this room so they don't stack up
        if (matchTimers[roomId]) {
            clearInterval(matchTimers[roomId].intervalId);
        }

        // Check if the total 10-minute game length has run out
        if (Date.now() >= totalMatchEndTime) {
            io.to(roomId).emit('match_ended_draw', { reason: 'The 10-minute battle time limit has expired!' });
            return;
        }

        let secondsLeftForTurn = 60; // The 60-second rule

        // Tell both clients that a new turn window has officially started
        io.to(roomId).emit('turn_started', {
            activePlayerId: activePlayerSocketId,
            secondsLeft: secondsLeftForTurn
        });

        // 2. Start counting down every single second on the server

        const intervalId = setInterval(() => {
            secondsLeftForTurn--;

            // 3. KNOCKOUT TRIGGER: Time is completely up!
            if (secondsLeftForTurn <= 0) {
                clearInterval(intervalId);
                delete matchTimers[roomId];

                // Execute the automatic kick-out rule
                executeAutomaticTimeout(roomId, activePlayerSocketId);
            }
        }, 1000);

        // Keep track of this room's timer so we can reset it when they send an argument
        matchTimers[roomId] = { intervalId, activePlayerSocketId };
    }

    function executeAutomaticTimeout(roomId, losingPlayerId) {
        console.log(`Match ${roomId}: Player ${losingPlayerId} failed to reply in 60s. Auto-removed.`);

        const match = activeMatches.find(m => m.roomId === roomId);

        if (match) {

            const winnerRole = losingPlayerId === match.creatorSocketId ? 'challenger' : 'creator';
            archiveMatch(match, 'timeout', winnerRole);
        }



        // Send a defeat signal to the slow player
        io.to(losingPlayerId).emit('match_ended_lost', { 
            reason: 'You were kicked out of the match for failing to reply within 60 seconds!' 
        });

        // Send a victory signal to the remaining player in that specific socket room
        io.to(roomId).emit('match_ended_won', { 
            winnerId: losingPlayerId, // Used on frontend to check who won
            reason: 'Your opponent went silent for over 60 seconds and has been removed! You win! 🏆' 
        });
    }


    // B. Trigger this inside your argument submission receiver
    socket.on('submit_argument', (data) => {
        const { roomId, nextPlayerId, totalMatchEndTime } = data;
        
        // ... (Process and send the text message to the screen normally) ...

        // Reset the 60-second shot clock instantly for the next player
        startTurnTimeoutClock(roomId, nextPlayerId, totalMatchEndTime);
    });

    


    /* ---------- DISCONNECT ---------- */

    socket.on('disconnect', () => {

        console.log(
            `Disconnected: ${socket.id}`
        );

        globalMatchmakingQueue =
            globalMatchmakingQueue.filter(
                duel =>
                    duel.socketId !== socket.id
            );

        const roomsToRemove = [];

        activeMatches.forEach(match => {

            const isCreator = match.creatorSocketId === socket.id;
            const isChallenger = match.challengerSocketId === socket.id;

            if (isCreator || isChallenger) {
                const role = isCreator ? 'creator' : 'challenger';

                const timer = setTimeout(() => {
                    const stillSameSocket =
                        (role === 'creator' && match.creatorSocketId === socket.id) ||
                        (role === 'challenger' && match.challengerSocketId === socket.id);

                    if (!stillSameSocket) return;

                    archiveMatch(match, 'disconnected');

                    io.to(match.roomId).emit('match_ended', { reason: 'A debater disconnected.' });
                    activeMatches = activeMatches.filter(m => m.roomId !== match.roomId);
                    broadcastLiveMatches();

                }, DISCONNECT_GRACE_MS);

                match.pendingDisconnect[role] = timer;

            } else {
                match.spectators = match.spectators.filter(id => id !== socket.id);
                io.to(match.roomId).emit('spectator_count_changed', { count: match.spectators.length });
            }

        
        });



// setTimeout



        activeMatches =
            activeMatches.filter(
                match =>
                    !roomsToRemove.includes(
                        match.roomId
                    )
            );
            
        broadcastLiveMatches();

        io.emit(
            'update_duel_list',
            globalMatchmakingQueue
        );
    });

});

/* ---------------- CLEANUP ---------------- */

setInterval(() => {

    const now = Date.now();

    globalMatchmakingQueue =
        globalMatchmakingQueue.filter(
            duel =>
                now - duel.startTime <
                60 * 60 * 1000
        );

    io.emit(
        'update_duel_list',
        globalMatchmakingQueue
    );

}, 60 * 1000);

/* ---------------- SERVER ---------------- */

server.listen(3000, () => {
    console.log(
        'Arena live at http://localhost:3000'
    );
});

