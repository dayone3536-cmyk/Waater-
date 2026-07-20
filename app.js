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

// .not('ended_at', 'is', null)

app.use(express.static(__dirname));


const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Give every visitor a stable anonymous ID via cookie if they don't have one.
// (This is a fallback identity for the reactions table — separate from Firebase login.)
app.use((req, res, next) => {
    if (!req.cookies.anonId) {

        const anonId = crypto.randomUUID();
        res.cookie('anonId', anonId, {

            maxAge: 365 * 24 * 60 * 60 * 1000,
            httpOnly: true,

            sameSite: 'lax'

        });
        req.cookies.anonId = anonId;
    }
    next();
});


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

app.get('/wake-up', (req, res) => {
    res.sendFile(__dirname + '/wake.html');
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

app.get('/sigh', (req, res) => {
    res.sendFile(__dirname + '/sigh.html');
});

// Add this simple route 


app.get('/ping', (req, res) => {
    res.status(200).send('OK');
});


app.get('/past-matches', async (req, res) => {
    const userId = req.cookies.anonId;

    const { data: matches, error } = await supabase
        .from('past_matches')
        .select('*')

        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        
        .limit(50);

    if (error) return res.status(500).json({ error: error.message });

    if (!matches || matches.length === 0) {
        return res.json([]);
    }

    const roomIds = matches.map(m => m.room_id);

    const { data: reactions, error: reactErr } = await supabase
        .from('match_reactions')
        .select('room_id, user_id, reaction')
        .in('room_id', roomIds);

    if (reactErr) return res.status(500).json({ error: reactErr.message });

    const enriched = matches.map(m => {
        const matchReactions = reactions.filter(r => r.room_id === m.room_id);
        const mine = matchReactions.find(r => r.user_id === userId);
        return {
            ...m,
            like_count: matchReactions.filter(r => r.reaction === 'like').length,
            dislike_count: matchReactions.filter(r => r.reaction === 'dislike').length,
            myReaction: mine ? mine.reaction : null
        };
    });

    res.json(enriched);
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

app.post('/past-matches/:roomId/vote', express.json(), async (req, res) => {
    const { roomId } = req.params;
    const { side } = req.body;
    const userId = req.cookies.anonId; // same anonymous identity you already use for reactions

    if (!['pro', 'against'].includes(side)) {
        return res.status(400).json({ error: 'Invalid side' });
    }

    const { error } = await supabase
        .from('match_votes')
        .upsert(
            { room_id: roomId, user_id: userId, side },
            { onConflict: 'room_id,user_id' }
        );

    if (error) return res.status(500).json({ error: error.message });

    const { data, error: fetchErr } = await supabase
        .from('match_votes')
        .select('side')
        .eq('room_id', roomId);

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });

    const tally = { pro: 0, against: 0 };
    (data || []).forEach(v => tally[v.side]++);

    res.json({ ...tally, myVote: side });
});


app.post('/match/:roomId/invite', express.json(), async (req, res) => {
    const { roomId } = req.params;
    const { side } = req.body;
    const userId = req.cookies.anonId;

    if (!['pro', 'against'].includes(side)) {
        return res.status(400).json({ error: 'Invalid side' });
    }

    const code = crypto.randomBytes(6).toString('hex');

    const { error } = await supabase.from('match_invites').insert({
        code,
        room_id: roomId,
        inviter_user_id: userId,
        inviter_side: side
    });

    if (error) return res.status(500).json({ error: error.message });

    res.json({ code });
});

app.post('/invite/:code/redeem', async (req, res) => {

    const { code } = req.params;
    const redeemerId = req.cookies.anonId;

    const { data: invite, error: fetchErr } = await supabase
        .from('match_invites')
        .select('*')
        .eq('code', code)
        .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.redeemed_at) return res.json({ redeemed: false, reason: 'already_redeemed' });
    if (invite.inviter_user_id === redeemerId) return res.json({ redeemed: false, reason: 'self_invite' });

    const { error: updErr } = await supabase
        .from('match_invites')
        .update({ redeemed_at: new Date().toISOString(), redeemed_by: redeemerId })
        .eq('code', code);

    if (updErr) return res.status(500).json({ error: updErr.message });

    const { data: existingBonus } = await supabase
        .from('match_invite_bonus')
        .select('bonus')
        .eq('room_id', invite.room_id)
        .eq('user_id', invite.inviter_user_id)
        .maybeSingle();

    const newBonus = (existingBonus?.bonus || 0) + 5;

    const { error: bonusErr } = await supabase
        .from('match_invite_bonus')
        .upsert(
            { room_id: invite.room_id, user_id: invite.inviter_user_id, side: invite.inviter_side, bonus: newBonus, updated_at: new Date().toISOString() },
            { onConflict: 'room_id,user_id' }
        );

    if (bonusErr) return res.status(500).json({ error: bonusErr.message });

    const { data: match } = await supabase
        .from('past_matches')
        .select('thesis')
        .eq('room_id', invite.room_id)
        .maybeSingle();

    const topicText = match ? match.thesis : 'a debate';

    await supabase.from('user_notifications').insert({
        user_id: invite.inviter_user_id,
        message: `Congratulations! Your friend signed in — you got 5 free votes in "${topicText}"!`,
        room_id: invite.room_id
    });

    res.json({ redeemed: true, bonus: newBonus });
});

app.get('/notifications/pending', async (req, res) => {
    const userId = req.cookies.anonId;

    const { data, error } = await supabase
        .from('user_notifications')
        .select('*')
        .eq('user_id', userId)
        .is('read_at', null)
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);

});

app.post('/notifications/:id/ack', async (req, res) => {

    const { id } = req.params;
    const { error } = await supabase
        .from('user_notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.sendStatus(204);

});



app.get('/past-matches/:roomId/invite-bonus', async (req, res) => {
    const userId = req.cookies.anonId;

    const { data, error } = await supabase
        .from('match_invite_bonus')
        .select('bonus')
        .eq('room_id', req.params.roomId)
        .eq('user_id', userId)
        .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ bonus: data ? data.bonus : 0 });
});




app.post('/engagement/dwell', express.json(), async (req, res) => {

    const { roomId, seconds } = req.body || {} ;

    const userId = req.cookies.anonId;
    
    if (!roomId || !seconds) return res.sendStatus(400);

    await supabase.from('user_engagement').insert({
        user_id: userId,
        room_id: roomId,
        event_type: 'view_end',
        value: seconds
    });

    const { data: match } = await supabase
        .from('past_matches')
        .select('thesis')
        .eq('room_id', roomId)
        .maybeSingle();

    if (match) {

        await bumpAffinity(userId, match.thesis, seconds > 30 ? 1 : 0);

    }


    res.sendStatus(204);
});




app.post('/match/:roomId/react', express.json(), async (req, res) => {

    const { roomId } = req.params;
    const { reaction } = req.body;
    const userId = req.cookies.anonId;

    if (!['like', 'dislike'].includes(reaction)) {
        return res.status(400).json({ error: 'Invalid reaction type' });
    }

    try {
        const { data: existing, error: fetchErr } = await supabase
            .from('match_reactions')
            .select('*')
            .eq('room_id', roomId)
            .eq('user_id', userId)
            .maybeSingle();

        if (fetchErr) throw fetchErr;

        let myReaction = null;

        if (existing && existing.reaction === reaction) {
            const { error: delErr } = await supabase
                .from('match_reactions')
                .delete()
                .eq('id', existing.id);
            if (delErr) throw delErr;
            myReaction = null;

        } else if (existing && existing.reaction !== reaction) {
            const { error: updErr } = await supabase
                .from('match_reactions')
                .update({ reaction })
                .eq('id', existing.id);
            if (updErr) throw updErr;
            myReaction = reaction;

        } else {
            const { error: insErr } = await supabase
                .from('match_reactions')
                .insert({ room_id: roomId, user_id: userId, reaction });
            if (insErr) throw insErr;
            myReaction = reaction;
        }

        const { count: likeCount } = await supabase
            .from('match_reactions')
            .select('*', { count: 'exact', head: true })
            .eq('room_id', roomId)
            .eq('reaction', 'like');

        const { count: dislikeCount } = await supabase
            .from('match_reactions')
            .select('*', { count: 'exact', head: true })
            .eq('room_id', roomId)
            .eq('reaction', 'dislike');

        res.json({
            myReaction,
            like_count: likeCount || 0,
            dislike_count: dislikeCount || 0
        });

        const { data: match } = await supabase.from('past_matches').select('thesis').eq('room_id', roomId).maybeSingle();
    
        if (match) {
            await bumpAffinity(userId, match.thesis, reaction === 'like' ? 3 : -1);
        }

    } catch (err) {
        console.error('Reaction error:', err);
        res.status(500).json({ error: 'Failed to update reaction' });
    }
});


app.get('/past-matches/:roomId/votes', async (req, res) => {
    const userId = req.cookies.anonId;

    const { data, error } = await supabase
        .from('match_votes')
        .select('side, user_id')
        .eq('room_id', req.params.roomId);

    if (error) return res.status(500).json({ error: error.message });

    const tally = { pro: 0, against: 0 };
    (data || []).forEach(v => tally[v.side]++);

    const mine = (data || []).find(v => v.user_id === userId);

    res.json({ ...tally, myVote: mine ? mine.side : null });
});


app.post('/match/:roomId/share', async (req, res) => {
    const { roomId } = req.params;
    const userId = req.cookies.anonId;

    const { data: match } = await supabase
        .from('past_matches')
        .select('thesis')
        .eq('room_id', roomId)
        .maybeSingle();

    if (match) {
        await supabase.from('user_engagement').insert({
            user_id: userId,
            room_id: roomId,
            event_type: 'share',
            value: 1
        });
        await bumpAffinity(userId, match.thesis, 5);
    }

    res.sendStatus(204);
    
});




// Put this ABOVE io.on('connection')send_argument join_room     cast_vote



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


async function bumpAffinity(userId, thesis, weight) {

    const topics = extractTopics(thesis);

    for (const topic of topics) {
        const { data: existing } = await supabase

            .from('user_topic_affinity')
            .select('score')
            .eq('user_id', userId)

            .eq('topic', topic)
            .maybeSingle();

        const newScore = (existing?.score || 0) + weight;

        await supabase
            .from('user_topic_affinity')

            .upsert({ user_id: userId, topic, score: newScore, updated_at: new Date().toISOString() },

                     { onConflict: 'user_id,topic' });

    }
}

const STOPWORDS = new Set(['about','should','their','there','which','would','could','because','other','these','those','where','being']);

function extractTopics(thesis) {

    return thesis

            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 4 && !STOPWORDS.has(w))
            .slice(0, 5); // keep it to a few meaningful words per debate

    }


// activeMatches loadReplayMode args async

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
        // }) macth_info

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

        socket.emit('duel_created', { matchId: newMatch.id });

        io.emit(
            'update_duel_list',
            globalMatchmakingQueue
        );
    });


    socket.on('join_match', (data) => { //macthID : macthID  cast_vote

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

//   leave_room 

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
 
            pendingDisconnect: {
                creator: null,
                challenger: null
            },

            votes: {} 

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

    socket.on('leave_queue', (data) => {

        if (!data || !data.matchId) return;

        globalMatchmakingQueue = globalMatchmakingQueue.filter(

            duel => duel.id !== data.matchId

        );

        console.log(`Duel removed from queue: ${data.matchId}`);

        io.emit(
            'update_duel_list',
            globalMatchmakingQueue
        );
        
    });


// activeMatches join_match

    socket.on('join_room', async  (data) => {

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

            await supabase.from('past_matches').update({ ended_at: null, end_reason: null }).eq('room_id', roomId);

        }

            else if (role === 'challenger') {

            match.challengerSocketId = socket.id;

            if (match.pendingDisconnect.challenger) {

                clearTimeout(match.pendingDisconnect.challenger);

                match.pendingDisconnect.challenger = null;

            }

             await supabase.from('past_matches').update({ ended_at: null, end_reason: null }).eq('room_id', roomId);

        } else {

            const isPlayer = match.creatorSocketId === socket.id || match.challengerSocketId === socket.id;
            if (!isPlayer) {

                match.spectators.push(socket.id);

                socket.emit('you_are_spectator');

                broadcastLiveMatches();

            }
        }

        socket.emit('macth_info', { thesis: match.thesis });

        supabase
            .from('past_arguments')
            .select('*')
            .eq('room_id', roomId)
            .order('created_at', { ascending: true })
            .then(({ data, error }) => {
                if (error) {
                    console.error('Failed to load match history:', error);
                    return;
                }
                socket.emit('match_history', data || []);
            });

        supabase
            .from('match_votes')
            .select('side')
            .eq('room_id', roomId)
            .then(({ data, error }) => {
                if (error) {
                    console.error('Failed to load vote tally:', error);
                    return;
                }
                const tally = { pro: 0, against: 0 };
                (data || []).forEach(v => tally[v.side]++);

                socket.emit('vote_update', {
                    proVotes: tally.pro,
                    againstVotes: tally.against
                });
            });

    }); 



   socket.on('leave_room', (data) => {

        const roomId = typeof data === 'string' ? data : data?.roomId;
        if (!roomId) return;

        socket.leave(roomId);

        const match = activeMatches.find(m => m.roomId === roomId);

        if (match) {

            match.spectators = match.spectators.filter(id => id !== socket.id);
            delete match.votes[socket.id];   // ADD THIS 

            io.to(match.roomId).emit('spectator_count_changed', { count: match.spectators.length });
            broadcastLiveMatches();
        }

    });



    socket.on('cast_vote', async (data) => {

        const roomId = typeof data === 'string' ? data : data?.roomId;
        const side = data?.side;

        if (!roomId || !['pro', 'against'].includes(side)) return;

        const match = activeMatches.find(m => m.roomId === roomId);

        if (match) {
            match.votes[socket.id] = side;
        }

        const { error } = await supabase
            .from('match_votes')
            .upsert(
                { room_id: roomId, user_id: socket.id, side },
                { onConflict: 'room_id,user_id' }
            );

        if (error) {
            console.error('Failed to save vote:', error);
            return;
        }

        if (match) {
            const tally = { pro: 0, against: 0 };
            Object.values(match.votes).forEach(v => tally[v]++);

            io.to(roomId).emit('vote_update', {
                proVotes: tally.pro,
                againstVotes: tally.against
            });

        } else {
            const { data: votes, error: fetchErr } = await supabase
                .from('match_votes')
                .select('side')
                .eq('room_id', roomId);

            if (fetchErr) {
                console.error('Failed to fetch tally after vote:', fetchErr);
                return;
            }

            const tally = { pro: 0, against: 0 };
            (votes || []).forEach(v => tally[v.side]++);

            socket.emit('vote_update', {
                proVotes: tally.pro,
                againstVotes: tally.against
            });
        }
        
    });



    socket.on('forfeit_match', (data) => {

        const roomId = typeof data === 'string' ? data : data?.roomId;
        if (!roomId) return;

        const match = activeMatches.find(m => m.roomId === roomId);
        if (!match) return;

        const isCreator = match.creatorSocketId === socket.id;
        const isChallenger = match.challengerSocketId === socket.id;

        if (!isCreator && !isChallenger) return; // only debaters can forfeit

        const winnerRole = isCreator ? 'challenger' : 'creator';
        const winnerSocketId = isCreator ? match.challengerSocketId : match.creatorSocketId;

        if (match.pendingDisconnect.creator) clearTimeout(match.pendingDisconnect.creator);
        if (match.pendingDisconnect.challenger) clearTimeout(match.pendingDisconnect.challenger);

        archiveMatch(match, 'forfeit', winnerRole);

        io.to(winnerSocketId).emit('match_ended_won', {
            reason: 'Your opponent forfeited the debate. You win! 🏆'

        });

        socket.emit('match_ended_lost', {
            reason: 'You forfeited the debate.'

        });

        match.spectators.forEach(specId => {
            io.to(specId).emit('match_ended', { reason: 'A debater forfeited the match.' });

        });

        activeMatches = activeMatches.filter(m => m.roomId !== roomId);

        broadcastLiveMatches();
        
    });









    // 2. Listen for 'send_argument' from your frontend Send button  const { data: matches, error } = await supabase
    socket.on('send_argument', (data) => {

        console.log(`Message received for room ${data.roomId}: ${data.message}`);

        const match = activeMatches.find(m => m.roomId === data.roomId);

        let senderRole = null;

        if (match) {

            if (socket.id === match.creatorSocketId) senderRole = 'creator';

            else if (socket.id === match.challengerSocketId) senderRole = 'challenger';

        }

    // typing

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

    socket.on('typing', (data) => {

        const roomId = typeof data === 'string' ? data : data?.roomId;
        if (!roomId) return;

        const match = activeMatches.find(m => m.roomId === roomId);
        let senderRole = null;

        if (match) {
            if (socket.id === match.creatorSocketId) senderRole = 'creator';
            else if (socket.id === match.challengerSocketId) senderRole = 'challenger';
        }

        // Broadcast to everyone else in the room (opponent + spectators), not back to sender
        socket.to(roomId).emit('opponent_typing', { senderRole });
    });

    socket.on('stop_typing', (data) => {
        const roomId = typeof data === 'string' ? data : data?.roomId;
        if (!roomId) return;

        socket.to(roomId).emit('opponent_stop_typing');
        
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

        // Keep track of this room's timer so we can reset it when they send an argument else 
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

                const winnerRole = role === 'creator' ? 'challenger' : 'creator';
                const winnerSocketId = role === 'creator' ? match.challengerSocketId : match.creatorSocketId;

                archiveMatch(match, 'disconnected', winnerRole);

                if (winnerSocketId) {
                    io.to(winnerSocketId).emit('match_ended_won', {
                        reason: 'Your opponent disconnected. You win! 🏆'
                    });
                }

                match.spectators.forEach(specId => {
                    io.to(specId).emit('match_ended', { reason: 'A debater disconnected.' });
                });

                activeMatches = activeMatches.filter(m => m.roomId !== match.roomId);
                broadcastLiveMatches();

            }, DISCONNECT_GRACE_MS);

            match.pendingDisconnect[role] = timer;

        } else {
            match.spectators = match.spectators.filter(id => id !== socket.id);
            delete match.votes[socket.id];
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
