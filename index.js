var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);

var redis = require('redis');
var redisCli = redis.createClient();

var circJSON = require('circular-json');

redisCli.on('connect', function() {
    console.log("Connected to redis");
});

app.get('/', function(req, res) {
    res.sendFile(__dirname + '/index.html');
});

app.get('/socket', function(req, res) {
    res.sendFile(__dirname + '/node_modules/socket.io-client/socket.io.js');
});

app.get('/:ip/:history', function(req, res) { // full convo archives; if ip doesn't exist, send a 404 for now; in future, redirect to login page if there is one
    // Extract user hash through ip key
    
    // If key doesn't exist
        // Write header 404
        // Send simple html saying they have never used the chat before
    // Else
        // Write header 200
        // Initialize empty list
        // Extract list of convo ids
        // For each convo id
            // Extract convo value string from id key, push to list
        // Return list to client
});

var sessionMessages = [];
//var delimiter = ';;;';
var numMembers = 0;
var sessionKey;
var activeIps = []; // used to keep track of who has already joined, to ignore multiple sockets from same IP

// Main Control Event-Handlers
io.on('connection', function(socket) {
    console.log('Booya! Someone connected.');
    var clientIp = socket.request.connection.remoteAddress;
    
    /* In production, can disable multiple sockets from same IP with this section
    if (activeIps.indexOf(clientIp) == -1) {
        activeIps.push(clientIp);
    }

    else {
        return; // Do not register any event handlers for duplicate sockets of same IP
    }
    */

    if (++numMembers == 1) {
        sessionKey = Date.now().toString();
        saveSessionKey(redisCli, sessionKey, true);
    }
    
    
    console.log("Client IP is " + clientIp + " and socket ID is " + socket.id);

    var clientName;
    
    getInfo(redisCli, clientIp, updateOrCreate, socket); // Will either retrieve data and save login of returning user, or prompt new user for name and save it

    //socket.emit('recent messages', sessionMessages.join(delimiter)); // Send new member the messages within session
    socket.emit('recent messages', sessionMessages);

    socket.on('chat message', function(name, msg) {
        console.log("New message from " + name + " : " + msg);
        socket.broadcast.emit('incoming', name, msg, socket.id); // send id to allow clients to uniquely identify message sender
        var msgToSave = formatMessage(name, msg);
        sessionMessages.push(msgToSave);
        saveMessage(redisCli, sessionKey, msgToSave);
        clientName = clientName || name; // In case it is an old user
    });
    
    socket.on('gotUsername', function(name) {
        if (name !== "Anonymous") { // If user entered no name, client-side returns Anonymous instead of undefined; don't save to database
            createUser(redisCli, clientIp, name);
        }
        socket.userName = name;

        // Refactor following 4 lines into separate method
        socket.broadcast.emit('new member', name);
        var joinMessage = joinMetadata(name);
        sessionMessages.push(joinMessage);
        saveMessage(redisCli, sessionKey, joinMessage);

        clientName = clientName || name;
    });
    socket.on('disconnect', function() {
        //socket.broadcast.emit('member quits', socket.userName);
        console.log("Socket " + socket.id + " is quitting; it's client name is " + clientName);
        if (clientName != null && clientName != undefined) { // Ignore duplicate sockets/stale sockets that timeout
            socket.broadcast.emit('member quits', clientName);
            // quitMetadata
            var quitMessage = quitMetadata(clientName);
            sessionMessages.push(quitMessage);
            saveMessage(redisCli, sessionKey, quitMessage);
            console.log('Aww...' +  clientName + ' disconnected.');
            saveToUserArchive(redisCli, clientIp, sessionKey, sessionMessages); // record end index of convo for the client here, so that his archive will not include convo messages after exit
        }
    });
});

http.listen(3000, function() {
    console.log("Listening on port 3000");
});

function getInfo(redisCli, ip, next, socket) {
    redisCli.hgetall(ip, function(err, res) {
        if (res == null || res == "null") {
            return next(false, redisCli, ip, socket);
        }
        console.log('Response from REDIS is ' + JSON.stringify(res));
        var info = res;
        var name = info['name'];

        console.log('Name is ' + name);
        socket.userName = name;
        //var messageHistory = info['messages']; // Add amount-limiting feature
        
        //console.log('Message History is ' + messageHistory);
       
        socket.emit('greeting', name);
        
        // The following 4 lines are repeated above, need to refactor into method
        socket.broadcast.emit('new member', name);
        var joinMessage = joinMetadata(name);
        sessionMessages.push(joinMessage);
        saveMessage(redisCli, sessionKey, joinMessage);

        //socket.emit('messageHistory', messageHistory); // Only what the user himself said
        socket.emit('friends'); // Temp
        return next(true, redisCli, ip, socket);
    });    
}

// Control Logic Helper Functions
function updateOrCreate(oldUser, redisCli, ip, socket) {
    oldUser ? updateUser(redisCli, ip) : askUsername(socket);
}


function askUsername(socket) {
    socket.emit('askUsername');
}


// DB Functions - should extract into chat.js model file (perhaps in models folder) and import
function createUser(redisCli, ip, name) { // Only called on new users
    var timeNow = new Date();
    redisCli.hmset(ip, 'name', name, 'logins', 1, 'last-login', timeNow, 'friends', '[]', 'convoIDs', '', function(err, res) {
        if (err) {
            console.log("ERROR : Failed to create user " + name + ":");
            console.log(err);
        }
        else {
            console.log("Successfully saved user " + name);
        }
    });
}

function updateUser(redisCli, ip) { // Only called on old users
    var timeNow = new Date();
    redisCli.hmset(ip, 'last-login', timeNow, function(error, response) {
        console.log("Last login date of " + ip + " updated to " + timeNow);
    });
    redisCli.hincrby(ip, 'logins', 1, function(e, r) {
        console.log("This is " + ip + "'s login number " + r);
    });
}

function saveSessionKey(redisCli, key, original) {
    var sessionStart = new Date();
    var startMessage = "New conversation started on " + sessionStart;
    redisCli.rpush(key, startMessage, function(err, res) {
        if (err && original) {
            console.log("Failed to save session in DB : " + err);
            cosole.log("Trying again.");
            saveSessionKey(redisCli, key, false);
        }
        else if (!err) {
            console.log("Saved new conversation with key " + key + "; now saving key to global list of session keys");
            redisCli.rpush('sessionKeys', key, function(error, rep) {
                error ? console.log("Unable to save key to global list : " + error) : console.log("Saved session key to global list of keys, total sessions : " + rep);
            });
        }
        else {
            console.log("ERROR! Unable to save session despite repeated attempt. Message history will be lost.");
        }
    });
}

function saveMessage(redisCli, sessionKey, msg) {
    redisCli.rpush(sessionKey, msg, function(err, res) {
        if (!err) {
            console.log("Message saved. Total messages in this convo : " + res);
        }
        else {
            console.log("Error saving message : " + err);
        }
    });
}

function saveToUserArchive(redisCli, clientIp, sessionKey, sessionMsgs) {
    var endIndex = sessionMsgs.length;
    var archiveData = {"id" : sessionKey, "endIndex" : endIndex};
    var currentData;
    redisCli.hget(clientIp, 'convoIDs', function(err, rep) {
        if (err) {
            console.log('Unable to retrieve convoIDs string for client ' + clientIp + '; ' + err);
        }
        else {
            currentData = rep;
            if (rep.length == 0) {
                currentData = [];
            }
            else {
                currentData = JSON.parse(rep);
            }
            // currentData is now a list of objects
            currentData.push(archiveData);
            currentData = JSON.stringify(currentData); // REDIS does not supported nested objects, so convert to string before saving and convert back to object when loading
            console.log("Convo archives metadata for " + clientIp + " :");
            console.log(currentData);
            redisCli.hset(clientIp, 'convoIDs', currentData, function(error, resp) {
                if (error) {
                    console.log('Unable to save latest metadata to client ' + clientIp + ' convoIDs; ' + err);
                }
                else {
                    console.log('Updated ' + clientIp + ' convoIDs.');
                }
            
            });
        }
    });


};


// Formatting functions - should extract into util.js (perhaps in a lib folder) and import
function joinMetadata(name) {
    return "[INFO : " + name + " joined the chat at " + new Date() + " ]";
}

function quitMetadata(name) {
    return "[INFO : " + name + " left the chat at " + new Date() + " ] ";
}

function formatMessage(name, message) {
    return name + " [ " + new Date() + " ] : " + message;
}


/*
function formatTime() {
   
}
*/
