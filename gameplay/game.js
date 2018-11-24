var util = require("util");
var Room = require("./room");
var PlayersReadyNotReady = require("./playersReadyNotReady");

var usernamesIndexes = require("../myFunctions/usernamesIndexes");


var mongoose = require("mongoose");
var User = require("../models/user");
var GameRecord = require("../models/gameRecord");

mongoose.connect("mongodb://localhost/TheNewResistanceUsers");


var avalonRolesIndex = require("./avalon/indexRoles");
var avalonPhasesIndex = require("./avalon/indexPhases")
var avalonCardsIndex = require("./avalon/indexCards");
var commonPhasesIndex = require("./indexCommonPhases");

function Game (host_, roomId_, io_, maxNumPlayers_, newRoomPassword_){
	//********************************
	//CONSTANTS
	//********************************
	this.minPlayers = 5;
	this.alliances = [
		"Resistance",
		"Resistance",
		"Resistance",
		"Spy",
		"Spy",
		"Resistance",
		"Spy",
		"Resistance",
		"Resistance",
		"Spy"
	];

	this.numPlayersOnMission = [
		["2", "3", "2", "3", "3"],
		["2", "3", "4", "3", "4"],
		["2", "3", "3", "4*", "4"],
		["3", "4", "4", "5*", "5"],
		["3", "4", "4", "5*", "5"],
		["3", "4", "4", "5*", "5"],
	];

	//Get the Room properties
	Room.call(this, host_, roomId_, io_, maxNumPlayers_, newRoomPassword_);
	PlayersReadyNotReady.call(this, this.minPlayers);

	var thisRoom = this;
	this.gameMode = "avalon";

	this.avalonRoles = (new avalonRolesIndex).getRoles(thisRoom);
	this.avalonPhases = (new avalonPhasesIndex).getPhases(thisRoom);
	this.avalonCards = (new avalonCardsIndex).getCards(thisRoom);


	this.commonPhases = (new commonPhasesIndex).getPhases(thisRoom);
	this.specialRoles = this.avalonRoles;
	this.specialPhases = this.avalonPhases;
	this.specialCards = this.avalonCards;

	/*
		Handle joining:
			- If game hasn't started, join like usual
			- If game has started, check if they are a player
				- If they are player, give them data
				- If they are not a player, give them spec data
	*/

	/*
		Phases go like this:
			Note: Cards run should be run every time phase changes

			Always run between phases:
				- Card
				- Role specials (e.g. assassination)

			Start from phase 1:
			1) Player picking.
			2) Receive interactions for team votes.
				- If approved, go to phase 3.
				- If rejected, go to phase 1.
			3) Receive interactions for mission votes.
				- If game finished, go to phase 4.
				- If game not finished, go to phase 1.
			4) Game finished



			Table:
				Phase	|	String
				1			"pickingTeam"
				2			"votingTeam"
				3			"votingMission"
				4			"finished"

			Misc Phases:
				Phase	|	String
							"lady"
							"assassination"

	*/


	/* 
		Receive interactions depending on current state
	*/

	// Game variables
	this.gameStarted 					= false;
	this.finished 						= false;

	this.phase					 		= "pickingTeam";

	this.playersInGame 					= [];
	this.playerUsernamesInGame			= [];

	this.resistanceUsernames = [];
	this.spyUsernames = [];

	this.roleKeysInPlay					= [];
	this.cardKeysInPlay					= [];

	this.teamLeader 					= 0;
	this.hammer 						= 0;
	this.missionNum 					= 0;
	this.pickNum 						= 0;
	this.missionHistory 				= [];
	this.proposedTeam 					= [];
	this.lastProposedTeam 				= [];
	this.votes 							= [];
	//Only show all the votes when they've all come in, not one at a time
	this.publicVotes 					= []; 
	this.missionVotes 					= [];

	this.voteHistory 					= {};

	// Game misc variables
	this.winner							= "";
	this.moreThanOneFailMissions 		= [];
	this.options 						= undefined;

	// Room variables
	this.destroyRoom 					= false;
	
	// Room misc variables
	this.chatHistory 					= []; // Here because chatHistory records after game starts

}

//Game object inherits all the functions and stuff from Room
Game.prototype = Object.create(Room.prototype);
Object.assign(Game.prototype, PlayersReadyNotReady.prototype);




//RECOVER GAME!
Game.prototype.recoverGame = function(){

	// Set a few variables back to new state
	this.allSockets = [];
	this.socketsOfPlayers = [];
	this.frozen = true;
	this.timeFrozenLoaded = new Date();
	this.someCutoffPlayersJoined = "no";

	// Reload all objects so that their functions are also generated
	// Functions are not stored with JSONified during storage
	this.commonPhases = (new commonPhasesIndex).getPhases(this);

	//New Room Object - Just add in the new functions we need
	var roomFunctions = {};

	Game.prototype = Object.assign(Game.prototype, roomFunctions);
	Object.assign(Game.prototype, PlayersReadyNotReady.prototype);

	
	if(this.gameMode === "avalon"){
		this.avalonRoles = (new avalonRolesIndex).getRoles(this);
		this.avalonPhases = (new avalonPhasesIndex).getPhases(this);
		this.avalonCards = (new avalonCardsIndex).getCards(this);
		
		this.specialRoles = this.avalonRoles;
		this.specialPhases = this.avalonPhases;
		this.specialCards = this.avalonCards;
	}




}

//------------------------------------------------
// METHOD OVERRIDES ------------------------------
//------------------------------------------------
Game.prototype.playerJoinRoom = function (socket, inputPassword) {
	if(this.gameStarted === true){
		//if the new socket is a player, add them to the sockets of players
		for(var i = 0; i < this.playersInGame.length; i++){
			if(this.playersInGame[i].username === socket.request.user.username){
				this.socketsOfPlayers.splice(i, 0, socket);
				this.playersInGame[i].request = socket.request;
				
				break;
			}
		}
		Room.prototype.playerJoinRoom.call(this, socket, inputPassword);		
		//sends to players and specs
		this.distributeGameData();

		if(this.someCutoffPlayersJoined === "no" && this.allSockets.length >= 5){
			this.frozen = false;
			this.someCutoffPlayersJoined === "yes";
		}
	}
	else{
		Room.prototype.playerJoinRoom.call(this, socket, inputPassword);		
	}
};

Game.prototype.playerSitDown = function(socket){
	// If the game has started 
	if(this.gameStarted === true){
		socket.emit("danger-alert", "Game has already started.");
		return;
	}
	// If the ready/not ready phase is ongoing
	else if(this.canJoin === false){
		socket.emit("danger-alert", "The game is currently trying to start (ready/not ready phase). You can join if someone is not ready, or after 10 seconds has elapsed.");
		return;
	}

	Room.prototype.playerSitDown.call(this, socket);
};

Game.prototype.playerStandUp = function(socket){
	//If the ready/not ready phase is ongoing
	if(this.canJoin === false){
		// socket.emit("danger-alert", "The game is currently trying to start (ready/not ready phase). You cannot stand up now.");
		return;
	}
	// If the game has started
	else if(this.gameStarted === true){
		socket.emit("danger-alert", "The game has started... You shouldn't be able to see that stand up button!");
		return;
	}

	Room.prototype.playerStandUp.call(this, socket);
};

Game.prototype.playerLeaveRoom = function(socket){
	if(this.gameStarted === true){

		//if they exist in socketsOfPlayers, then remove them
		var index = this.socketsOfPlayers.indexOf(socket);
		if(index !== -1){
			this.socketsOfPlayers.splice(index, 1);	
		} 

		this.distributeGameData();
	}
	// If one person left in the room, the host would change
	// after the game started. So this will fix it
	var origHost = this.host;
	
	Room.prototype.playerLeaveRoom.call(this, socket);

	this.host = origHost;
};
	

//start game
Game.prototype.startGame = function (options) {
	if(this.socketsOfPlayers.length < 5 || this.socketsOfPlayers.length > 10 || this.gamePlayerLeftDuringReady === true){
		this.canJoin = true;
		this.gamePlayerLeftDuringReady = false;
		return false;
	}
	this.startGameTime = new Date();


	//make game started after the checks for game already started
	this.gameStarted = true;

	var rolesAssignment = generateAssignmentOrders(this.socketsOfPlayers.length);

	var shuffledPlayerAssignments = [];
	//shuffle the players around. Make sure to redistribute this room player data in sockets.
	for(var i = 0; i < this.socketsOfPlayers.length; i++){
		shuffledPlayerAssignments[i] = i;
	}
	shuffledPlayerAssignments = shuffle(shuffledPlayerAssignments);

	var tempSockets = [];
	//create temp sockets
	for(var i = 0; i < this.socketsOfPlayers.length; i++){
		tempSockets[i] = this.socketsOfPlayers[i];
	}

	//assign the shuffled sockets
	for(var i = 0; i < this.socketsOfPlayers.length; i++){
		this.socketsOfPlayers[i] = tempSockets[shuffledPlayerAssignments[i]];
	}

	//Now we initialise roles
	for (var i = 0; i < this.socketsOfPlayers.length; i++) {
		this.playersInGame[i] = {};
		//assign them the sockets but with shuffled. 
		this.playersInGame[i].username = this.socketsOfPlayers[i].request.user.username;
		this.playersInGame[i].userId = this.socketsOfPlayers[i].request.user._id;

		this.playersInGame[i].request = this.socketsOfPlayers[i].request;

		//set the role to be from the roles array with index of the value
		//of the rolesAssignment which has been shuffled
		this.playersInGame[i].alliance = this.alliances[rolesAssignment[i]];

		this.playerUsernamesInGame.push(this.socketsOfPlayers[i].request.user.username);
	}


	for(var key in this.specialRoles){
		if(this.specialRoles.hasOwnProperty(key)){
			console.log("Key: " + key);
		}
	}

	//Give roles to the players according to their alliances
	//Get roles:
	this.resRoles = [];
	this.spyRoles = [];

	// For every role we get given:
	for(var key in options){
		if(options.hasOwnProperty(key)){
			// If the role is selected in game: 
			if(options[key] === true){

				// If a role file exists for this
				if(this.specialRoles.hasOwnProperty(key)){
					// If it is a res:
					if(this.specialRoles[key].alliance === "Resistance"){
						this.resRoles.push(this.specialRoles[key].role);
					}
					else if(this.specialRoles[key].alliance === "Spy"){
						this.spyRoles.push(this.specialRoles[key].role);
					}
					else{
						console.log("THIS SHOULD NOT HAPPEN! Invalid role file. Look in game.js file.");
					}
					this.roleKeysInPlay.push(key)
				}

				// If a card file exists for this
				else if(this.specialCards.hasOwnProperty(key)){
					this.cardKeysInPlay.push(key);
					//Initialise the card
				}
				else{
					console.log("Warning: Client requested a role that doesn't exist -> " + key);
				}
			}
		}
	}

	var resPlayers = [];
	var spyPlayers = [];

	for (var i = 0; i < this.playersInGame.length; i++) {
		if (this.playersInGame[i].alliance === "Resistance") {
			resPlayers.push(i); 
			this.resistanceUsernames.push(this.playersInGame[i].username);
		}
		else if (this.playersInGame[i].alliance === "Spy") {
			spyPlayers.push(i);
			this.spyUsernames.push(this.playersInGame[i].username);
			
		}
	}

	// Assign the res roles randomly
	rolesAssignment = generateAssignmentOrders(resPlayers.length);
	for (var i = 0; i < rolesAssignment.length; i++) {
		this.playersInGame[resPlayers[i]].role = this.resRoles[rolesAssignment[i]];
		// console.log("res role: " + resRoles[rolesAssignment[i]]);
	}

	// Assign the spy roles randomly
	rolesAssignment = generateAssignmentOrders(spyPlayers.length);
	for (var i = 0; i < rolesAssignment.length; i++) {
		this.playersInGame[spyPlayers[i]].role = this.spyRoles[rolesAssignment[i]];
		// console.log("spy role: " + spyRoles[rolesAssignment[i]]);
	}


	//for those players with no role, set their role to their alliance (i.e. for Resistance VT and Spy VS)
	for (var i = 0; i < this.playersInGame.length; i++) {
		// console.log(this.playersInGame[i].role);
		if (this.playersInGame[i].role === undefined) {
			this.playersInGame[i].role = this.playersInGame[i].alliance;
			// console.log("Overwrite role as alliance for player: " + this.playersInGame[i].username);
		}
	}

	// Prepare the data for each person to see for the rest of the game.
	// The following data do not change as the game goes on.
	for (var i = 0; i < this.playersInGame.length; i++) {
		// Lowercase the role to give the file name
		let roleLower = this.playersInGame[i].role.toLowerCase();

		this.playersInGame[i].see = this.specialRoles[roleLower].see();
	}

	//set game start parameters
	//get a random starting team leader
	this.teamLeader = getRandomInt(0, this.playersInGame.length);
	this.hammer = ((this.teamLeader - 5 + 1 + this.playersInGame.length) % this.playersInGame.length);

	this.missionNum = 1;
	this.pickNum = 1;
	// this.missionHistory = ["succeeded", "failed", "succeeded"];
	this.missionHistory = [];

	var str = "Game started with: ";
	//add res roles: 
	for (var i = 0; i < this.resRoles.length; i++) {
		str += (this.resRoles[i] + ", ");
	}
	for (var i = 0; i < this.spyRoles.length; i++) {
		str += (this.spyRoles[i] + ", ");
	}

	// TODO: Need to add cards here!!!

	//remove the last , and replace with .
	str = str.slice(0, str.length - 2);
	str += ".";
	// this.gameplayMessage = str;
	this.sendText(this.allSockets, str, "gameplay-text");


	//seed the starting data into the VH
	for (var i = 0; i < this.playersInGame.length; i++) {
		this.voteHistory[this.playersInGame[i].request.user.username] = [];
	}

	this.distributeGameData();
	return true;
};




//**************************************************
//Get phase functions start*************************
//**************************************************

// var commonPhases = ["pickingTeam", "votingTeam", "votingMission", "finished"];
Game.prototype.gameMove = function (socket, data) {

	// Common phases
	if(this.commonPhases.hasOwnProperty(this.phase) === true){
		this.commonPhases[this.phase].gameMove(socket, data);		
	}

	// Special phases
	else if(this.specialPhases.hasOwnProperty(this.phase) === true){
		this.specialPhases[this.phase].gameMove(socket, data);
	}

	// THIS SHOULDN'T HAPPEN!!
	else{
		this.sendText(this.allSockets, "ERROR LET ADMIN KNOW IF YOU SEE THIS", "gameplay-text");
	}

	//RUN SPECIAL ROLE AND CARD CHECKS
	this.checkRoleCardSpecialMoves(socket, data);

	this.distributeGameData();
};

Game.prototype.toShowGuns = function(){
	// Common phases
	if(this.commonPhases.hasOwnProperty(this.phase) === true){
		return this.commonPhases[this.phase].showGuns;		
	}

	// Special phases
	else if(this.specialPhases.hasOwnProperty(this.phase) === true){
		this.specialPhases[this.phase].showGuns;
	}

	// THIS SHOULDN'T HAPPEN!!
	else{
		this.sendText(this.allSockets, "ERROR LET ADMIN KNOW IF YOU SEE THIS", "gameplay-text");
	}
}

Game.prototype.getClientNumOfTargets = function(indexOfPlayer){
	// Common phases
	if(this.commonPhases.hasOwnProperty(this.phase) === true){
		return this.commonPhases[this.phase].numOfTargets(indexOfPlayer);		
	}

	// Special phases
	else if(this.specialPhases.hasOwnProperty(this.phase) === true){
		return this.specialPhases[this.phase].numOfTargets(indexOfPlayer);
	}

	// THIS SHOULDN'T HAPPEN!!
	else{
		this.sendText(this.allSockets, "ERROR LET ADMIN KNOW IF YOU SEE THIS", "gameplay-text");
	}
};

Game.prototype.getClientButtonSettings = function(indexOfPlayer){
	if(indexOfPlayer !== undefined){
		// Common phases
		if(this.commonPhases.hasOwnProperty(this.phase) === true){
			return this.commonPhases[this.phase].buttonSettings(indexOfPlayer);
		}

		// Special phases
		else if(this.specialPhases.hasOwnProperty(this.phase) === true){
			return this.specialPhases[this.phase].buttonSettings(indexOfPlayer);
		}

		// THIS SHOULDN'T HAPPEN!!
		else{
			this.sendText(this.allSockets, "ERROR LET ADMIN KNOW IF YOU SEE THIS", "gameplay-text");
		}
	}
	// User is a spectator
	else{
		var obj = {
			green:{},
			red: {}
		};

		obj.green.hidden = true;
		obj.green.disabled = true;
		obj.green.setText = "";

		obj.red.hidden = true;
		obj.red.disabled = true;
		obj.red.setText = "";

		return obj;
	}
};

Game.prototype.getStatusMessage = function(indexOfPlayer){

	// Common phases
	if(this.commonPhases.hasOwnProperty(this.phase) === true){
		return this.commonPhases[this.phase].getStatusMessage(indexOfPlayer);
	}

	// Special phases
	else if(this.specialPhases.hasOwnProperty(this.phase) === true){
		return this.specialPhases[this.phase].getStatusMessage(indexOfPlayer);
	}

	// THIS SHOULDN'T HAPPEN!!
	else{
		this.sendText(this.allSockets, "ERROR LET ADMIN KNOW IF YOU SEE THIS", "gameplay-text");
	}
};

//**************************************************
//Get phase functions end***************************
//**************************************************





Game.prototype.incrementTeamLeader = function(){
	//move to next team Leader, and reset it back to the start if 
	//we go into negative numbers
	this.teamLeader--;
	if (this.teamLeader < 0) {
		this.teamLeader = this.playersInGame.length - 1;
	}
	this.pickNum++;
}

Game.prototype.getRoomPlayers = function () {
	if(this.gameStarted === true){
		var roomPlayers = [];
		
		for (var i = 0; i < this.playersInGame.length; i++) {
			var isClaiming;
			//If the player's username exists on the list of claiming:
			if(this.claimingPlayers.indexOf(this.playersInGame[i].request.user.username) !== -1){
				isClaiming = true;
			}
			else{
				isClaiming = false;
			}

			roomPlayers[i] = {
				username: this.playersInGame[i].request.user.username,
				avatarImgRes: this.playersInGame[i].request.user.avatarImgRes,
				avatarImgSpy: this.playersInGame[i].request.user.avatarImgSpy,
				avatarHide: this.playersInGame[i].request.user.avatarHide,
				claim: isClaiming
			}

			//give the host the teamLeader star
			if (roomPlayers[i].username === this.host) {
				roomPlayers[i].teamLeader = true;
			}
		}
		return roomPlayers;
	}
	else{
		return Room.prototype.getRoomPlayers.call(this);
	}
}



Game.prototype.distributeGameData = function(){
	//distribute roles to each player

	this.updateRoomPlayers();

	if(this.gameStarted === true){

		var gameData = this.getGameData();

		for(var i = 0; i < this.playersInGame.length; i++){
			var index = usernamesIndexes.getIndexFromUsername(this.socketsOfPlayers, this.playersInGame[i].request.user.username);

			//need to go through all sockets, but only send to the socket of players in game
			if(this.socketsOfPlayers[index]){
				this.socketsOfPlayers[index].emit("game-data", gameData[i])

				// console.log("Sent to player: " + this.playersInGame[i].request.user.username + " role " + gameData[i].role);
			}
		}
	
		var gameDataForSpectators = this.getGameDataForSpectators();

		var sockOfSpecs = this.getSocketsOfSpectators();
		sockOfSpecs.forEach(function(sock){
			sock.emit("game-data", gameDataForSpectators);
			// console.log("(for loop) Sent to spectator: " + sock.request.user.username);
		});
	}
};


Game.prototype.getGameData = function () {
	if(this.gameStarted == true){
		var data = {};

		var playerRoles = this.playersInGame;

		//set up the object first, because we cannot pass an array through
		//socket.io
		for (var i = 0; i < playerRoles.length; i++) {
			// Player specific data
			data[i] = {
				alliance: playerRoles[i].alliance,
				role: playerRoles[i].role,
				see: playerRoles[i].see,
				username: playerRoles[i].username,
				socketId: playerRoles[i].socketId
			};

			//add on these common variables:
			data[i].buttons 				= this.getClientButtonSettings(i);

			data[i].statusMessage 			= this.getStatusMessage(i);
			
			data[i].missionNum 				= this.missionNum;
			data[i].missionHistory 			= this.missionHistory;
			data[i].pickNum 				= this.pickNum;
			data[i].teamLeader 				= this.teamLeader;
			data[i].hammer 					= this.hammer;

			data[i].playersYetToVote 		= this.playersYetToVote;
			data[i].phase 					= this.phase;
			data[i].proposedTeam 			= this.proposedTeam;

			data[i].numPlayersOnMission 	= this.numPlayersOnMission[playerRoles.length - this.minPlayers]; //- 5
			data[i].numSelectTargets		= this.getClientNumOfTargets(i);

			data[i].votes 					= this.publicVotes;
			data[i].voteHistory 			= this.voteHistory;
			data[i].hammer 					= this.hammer;
			data[i].winner 					= this.winner;

			data[i].gameplayMessage 		= this.gameplayMessage;

			data[i].spectator 				= false;
			data[i].gamePlayersInRoom 		= getUsernamesOfPlayersInRoom(this);

			data[i].roomId 					= this.roomId;
			data[i].toShowGuns 				= this.toShowGuns();

			data[i].rolesCards				= this.getRoleCardPublicGameData();
			

			//if game is finished, reveal everything including roles
			if (this.phase === "finished") {
				data[i].see = {};
				data[i].see.spies = getAllSpies(this);
				data[i].see.roles = getRevealedRoles(this);
				data[i].proposedTeam = this.lastProposedTeam;
			}
			else if (this.phase === "assassination") {
				data[i].proposedTeam = this.lastProposedTeam;
			}
		}
		return data;
	}
	else{
		return "Game hasn't started";
	}
	
};


Game.prototype.getGameDataForSpectators = function () {
	// return false;
	var playerRoles = this.playersInGame;

	//set up the spectator data object
	var data = {};

	data.see 							= {};
	data.see.spies 						= [];
	data.see.merlins 					= [];

	data.buttons 						= this.getClientButtonSettings();

	data.statusMessage 					= this.getStatusMessage(-1);
	data.missionNum 					= this.missionNum;
	data.missionHistory 				= this.missionHistory;
	data.pickNum 						= this.pickNum;
	data.teamLeader 					= this.teamLeader;
	data.hammer 						= this.hammer;

	data.playersYetToVote 				= this.playersYetToVote;
	data.phase 							= this.phase;
	data.proposedTeam 					= this.proposedTeam;

	data.numPlayersOnMission 			= this.numPlayersOnMission[playerRoles.length - this.minPlayers]; //- 5
	data.numSelectTargets				= this.getClientNumOfTargets();

	data.votes 							= this.publicVotes;
	data.voteHistory 					= this.voteHistory;
	data.hammer 						= this.hammer;
	data.winner 						= this.winner;

	data.gameplayMessage 				= this.gameplayMessage;

	data.spectator 						= true;
	data.gamePlayersInRoom 				= getUsernamesOfPlayersInRoom(this);	

	data.roomId 						= this.roomId;
	data.toShowGuns 					= this.toShowGuns();

	data.rolesCards						= this.getRoleCardPublicGameData();
	

	//if game is finished, reveal everything including roles
	if (this.phase === "finished") {
		data.see = {};
		data.see.spies = getAllSpies(this);
		data.see.roles = getRevealedRoles(this);
		data.proposedTeam = this.lastProposedTeam;
	}

	return data;
}


//Misc game room functions
Game.prototype.addToChatHistory = function(data){
	//FOR TESTING
	// this.specialRoles.merlin.test();
	// this.specialRoles.percival.test();

	if(this.gameStarted === true){
		this.chatHistory.push(data);
	}


	if(data.message.includes("phase")){
		this.sendText(this.allSockets, "The current phase is: " + this.phase + ".", "gameplay-text");
	}
}



Game.prototype.getStatus = function () {
	if (this.finished === true) {
		return "Finished";
	}
	else if(this.frozen === true){
		return "Frozen";
	}
	else if (this.gameStarted === true) {
		return "Game in progress";
	} 
	else {
		return "Waiting";
	}
}



Game.prototype.finishGame = function(toBeWinner){
	this.phase = "finished";

	if(this.checkRoleCardSpecialMoves() === true){
		return;
	}

	// If after the special card/role check the phase is
	// not finished now, then don't run the rest of the code below
	if(this.phase !== "finished"){
		return;
	}

	for(var i = 0; i < this.allSockets.length; i++){
		this.allSockets[i].emit("gameEnded");
	}

	//game clean up
	this.finished = true;

	if(toBeWinner === "Resistance"){
		this.winner = "resistance";
	}
	else if(toBeWinner === "Spy"){
		this.winner = "spies";
	}

	if (this.winner === "spies") {
		// this.gameplayMessage = "The spies have won the game.";
		this.sendText(this.allSockets, "The spies have won the game.", "gameplay-text-red");
	}
	else if (this.winner === "resistance") {
		// this.gameplayMessage = "The resistance have won the game.";
		this.sendText(this.allSockets, "The resistance have won the game.", "gameplay-text-blue");
	}

	// Reset votes
	this.votes = [];
	this.publicVotes = [];

	this.distributeGameData();



	//store data into the database:
	var rolesCombined = [];
	
	//combine roles
	for(var i = 0; i < (this.resRoles.length + this.spyRoles.length); i++){
		if(i < this.resRoles.length){
			rolesCombined[i] = this.resRoles[i];
		}
		else{
			rolesCombined[i] = this.spyRoles[i-this.resRoles.length];
		}
	}

	var playerRolesVar = {};

	for(var i = 0; i < this.playersInGame.length; i++){
		playerRolesVar[this.playersInGame[i].username] = {
			alliance: this.playersInGame[i].alliance,
			role: this.playersInGame[i].role
		}
	}
	
	var objectToStore = {
		timeGameStarted: this.startGameTime,
		timeAssassinationStarted: this.startAssassinationTime,
		timeGameFinished: new Date(),
		winningTeam: this.winner,
		spyTeam: this.spyUsernames,
		resistanceTeam: this.resistanceUsernames,
		numberOfPlayers: this.playersInGame.length,
		howTheGameWasWon: this.howWasWon,
		roles: rolesCombined,

		missionHistory: this.missionHistory,
		voteHistory: this.voteHistory,
		playerRoles: playerRolesVar,

		ladyChain: this.ladyChain,
		whoAssassinShot: this.whoAssassinShot,

		moreThanOneFailMissions: this.moreThanOneFailMissions
	};

	GameRecord.create(objectToStore, function(err){
		if(err){
			console.log(err);
		}
		else{
			// console.log("Stored game data successfully.");
		}
	});

	//store player data:
	var timeFinished = new Date();
	var timeStarted = new Date(this.startGameTime);

	var gameDuration = new Date(timeFinished - timeStarted);


	var playersInGameVar = this.playersInGame;
	var winnerVar = this.winner;

	this.playersInGame.forEach(function(player){

		User.findById(player.userId).populate("modAction").populate("notifications").exec(function(err, foundUser){
			if(err){console.log(err);}
			else{
				if(foundUser){
					foundUser.totalTimePlayed = new Date(foundUser.totalTimePlayed.getTime() + gameDuration.getTime());
				
					//update individual player statistics
					foundUser.totalGamesPlayed += 1;

					if(winnerVar === player.alliance){
						foundUser.totalWins += 1;
						if(winnerVar === "Resistance"){
							foundUser.totalResWins += 1;
						}
					} else{
						//loss
						foundUser.totalLosses += 1;
						if(winnerVar === "Spy"){
							foundUser.totalResLosses += 1;
						}
					}

					//checks that the var exists
					if(!foundUser.winsLossesGameSizeBreakdown[playersInGameVar.length + "p"]){
						foundUser.winsLossesGameSizeBreakdown[playersInGameVar.length + "p"] = {
							wins: 0,
							losses: 0
						};
					}
					if(!foundUser.roleStats[playersInGameVar.length + "p"]){
						foundUser.roleStats[playersInGameVar.length + "p"] = {};
					}
					if(!foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()]){
						foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()] = {
							wins: 0,
							losses: 0
						};
					}


					if(winnerVar === player.alliance){
						//checks
						if(isNaN(foundUser.winsLossesGameSizeBreakdown[playersInGameVar.length + "p"].losses)){
							foundUser.winsLossesGameSizeBreakdown[playersInGameVar.length + "p"].wins = 0;
						}
						if(isNaN(foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()].wins)){
							foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()].wins = 0;
						}
						// console.log("=NaN?");
						// console.log(isNaN(foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()].wins));

						foundUser.winsLossesGameSizeBreakdown[playersInGameVar.length + "p"].wins += 1;
						foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()].wins += 1;
					}
					else{
						//checks
						if(isNaN(foundUser.winsLossesGameSizeBreakdown[playersInGameVar.length + "p"].losses)){
							foundUser.winsLossesGameSizeBreakdown[playersInGameVar.length + "p"].losses = 0;
						}
						if(isNaN(foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()].losses)){
							foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()].losses = 0;
						}

						foundUser.winsLossesGameSizeBreakdown[playersInGameVar.length + "p"].losses += 1;
						foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()].losses += 1;
					}
					// console.log("Rolestat for player");
					// console.log(foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()]);

					foundUser.markModified("winsLossesGameSizeBreakdown");
					foundUser.markModified("roleStats");
					
					foundUser.save();
					// console.log("SAVE SAVE");

				}
				
			}
		});
	});
};

Game.prototype.calcMissionVotes = function(votes) {

	var requiresTwoFails = false;
	if (this.playersInGame.length >= 7 && this.missionNum === 4) {
		requiresTwoFails = true;
	}

	//note we may not have all the votes from every person
	//e.g. may look like "fail", "undef.", "success"
	numOfPlayers = votes.length;

	var countSucceed = 0;
	var countFail = 0;

	var outcome;

	for (var i = 0; i < numOfPlayers; i++) {
		if (votes[i] === "succeed") {
			// console.log("succeed");
			countSucceed++;
		}
		else if (votes[i] === "fail") {
			// console.log("fail");
			countFail++;
		}
		else {
			console.log("Bad vote: " + votes[i]);
		}
	}

	//calcuate the outcome
	if (countFail === 0) {
		outcome = "succeeded";
	}
	else if (countFail === 1 && requiresTwoFails === true) {
		outcome = "succeeded";
	}
	else {
		outcome = "failed";
	}

	return outcome;
};


Game.prototype.checkRoleCardSpecialMoves = function(socket, data){
	var foundSomething = false;

	for(var i = 0; i < this.roleKeysInPlay.length; i++){
		//If the function doesn't exist, return null
		if(!this.specialRoles[this.roleKeysInPlay[i]].checkSpecialMove){continue;}

		if(this.specialRoles[this.roleKeysInPlay[i]].checkSpecialMove(socket, data) === true){
			foundSomething = true;
			break;
		}
	}
	// If we haven't found something in the roles, check the cards
	if(foundSomething === false){
		for(var i = 0; i < this.cardKeysInPlay.length; i++){
			//If the function doesn't exist, return null
			if(!this.specialCards[this.roleKeysInPlay[i]].checkSpecialMove){continue;}

			if(this.specialCards[this.cardKeysInPlay[i]].checkSpecialMove(socket, data) === true){
				foundSomething = true;
				break;
			}
		}
	}

	return foundSomething;
};


Game.prototype.getRoleCardPublicGameData = function(){
	var allData = {
		roles: {},
		cards: {}
	};
	for(var i = 0; i < this.roleKeysInPlay.length; i++){
		//If the function doesn't exist, return null
		if(!this.specialRoles[this.roleKeysInPlay[i]].getPublicGameData){continue;}

		let data = this.specialRoles[this.roleKeysInPlay[i]].getPublicGameData();
		Object.assign(allData.roles, data);
	}

	for(var i = 0; i < this.cardKeysInPlay.length; i++){
		//If the function doesn't exist, return null
		if(!this.specialRoles[this.roleKeysInPlay[i]].getPublicGameData()){continue;}

		let data = this.specialCards[this.cardKeysInPlay[i]].getPublicGameData();
		Object.assign(allData.cards, data);
	}

	return allData;
};



// Game.prototype.loadRoleCardData = function(roleData, cardData){
// 	this.specialRoles = (new avalonRolesIndex).getRoles(this);
// 	this.specialCards = (new avalonCardsIndex).getCards(this);

// 	//For every role
// 	for(var k1 in roleData){
// 		if(roleData.hasOwnProperty(k1)){

// 			//For every piece of data
// 			for(var k2 in roleData[k1]){
// 				if(roleData[k1].hasOwnProperty(k2)){
// 					this.specialRoles[k1][k2] = roleData[k1][k2];
// 				}
// 			}

// 			// For every role, update the "thisRoom" to point to this
// 			this.specialRoles[k1]["thisRoom"] = this;
// 		}
// 	}
	
// 	//For every role
// 	for(var k1 in cardData){
// 		if(cardData.hasOwnProperty(k1)){

// 			//For every piece of data
// 			for(var k2 in cardData[k1]){
// 				if(cardData[k1].hasOwnProperty(k2)){
// 					this.specialCards[k1][k2] = cardData[k1][k2];
// 				}
// 			}
// 			// For every card, update the "thisRoom" to point to this
// 			this.specialCards[k1]["thisRoom"] = this;
// 		}
// 	}
// };


// If entries don't exist for current missionNum and pickNum, create them
Game.prototype.VHCheckUndefined = function(){
	for (var i = 0; i < this.playersInGame.length; i++) {
		if (this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1] === undefined) {
			this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1] = [];
		}
		if (this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] === undefined) {
			this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] = "";
		}
	}
}

Game.prototype.VHUpdateTeamPick = function(){
	this.VHCheckUndefined();

	for (var i = 0; i < this.playersInGame.length; i++) {
		if (this.proposedTeam.indexOf(this.playersInGame[i].request.user.username) !== -1) {
			this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] += "VHpicked ";
		}

		if (i === this.teamLeader) {
			this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] += "VHleader ";
		}
	}
}

Game.prototype.VHUpdateTeamVotes = function(){
	this.VHCheckUndefined();

	for (var i = 0; i < this.playersInGame.length; i++) {
		this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] += ("VH" + this.votes[i]);
	}
}

// console.log((new Game).__proto__);

module.exports = Game;












// Helpful functions

function getRandomInt(min, max) {
	min = Math.ceil(min);
	max = Math.floor(max);
	return Math.floor(Math.random() * (max - min)) + min; //The maximum is exclusive and the minimum is inclusive
}

function shuffle(array) {
	var currentIndex = array.length, temporaryValue, randomIndex;
	// While there remain elements to shuffle...
	while (0 !== currentIndex) {
		// Pick a remaining element...
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;
		// And swap it with the current element.
		temporaryValue = array[currentIndex];
		array[currentIndex] = array[randomIndex];
		array[randomIndex] = temporaryValue;
	}
	return array;
}








function generateAssignmentOrders(num) {
	var rolesAssignment = [];

	//create the starting array for role assignment
	for (var i = 0; i < num; i++) {
		rolesAssignment[i] = i;
	}

	//shuffle
	rolesAssignment = shuffle(rolesAssignment);
	// console.log(rolesAssignment);

	return rolesAssignment;
}



// Unused function??

// function getRolesInStr(options) {
// 	var str = "";

// 	if (options.merlin === true) { str += "Merlin, "; }
// 	if (options.assassin === true) { str += "Assassin, "; }
// 	if (options.percival === true) { str += "Percival, "; }
// 	if (options.morgana === true) { str += "Morgana, "; }
// 	if (options.mordred === true) { str += "Mordred, "; }
// 	if (options.oberon === true) { str += "Oberon, "; }
// 	if (options.lady === true) { str += "Lady of the Lake, "; }

// 	//remove the last , and replace with .
// 	str = str.slice(0, str.length - 2);
// 	str += ".";

// 	return str;
// }

function getAllSpies(thisRoom) {
	if (thisRoom.gameStarted === true) {
		var array = [];
		for (var i = 0; i < thisRoom.playersInGame.length; i++) {
			if (thisRoom.playersInGame[i].alliance === "Spy") {
				array.push(thisRoom.playersInGame[i].username);
			}
		}
		return array;
	}
	else {
		return false;
	}
}

function getRevealedRoles(thisRoom) {
	if (thisRoom.gameStarted === true && thisRoom.phase === "finished") {
		var array = [];
		for (var i = 0; i < thisRoom.playersInGame.length; i++) {
			array.push(thisRoom.playersInGame[i].role);
		}
		return array;
	} else {
		return false;
	}
}

function getUsernamesOfPlayersInRoom(thisRoom) {
	if(thisRoom.gameStarted === true){
		var array = [];
		for(var i = 0; i < thisRoom.socketsOfPlayers.length; i++){
			array.push(thisRoom.socketsOfPlayers[i].request.user.username);
		}
		return array;
	}
	else{
		return [];
	}
}