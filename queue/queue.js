/**
 * queue.js
 *
 * Main project file
 *
 * node-red-contrib-msg-queue
 *
 * 23/5/17
 *
 * Copyright (C) 2017 Damien Clark (damo.clarky@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

module.exports = function (RED) {
	"use strict";

	var Queue = require('node-persistent-queue') ;
	var shallowequal = require('shallowequal') ;

	function QueueNode(config) {
		RED.nodes.createNode(this, config);

		this.name = config.name || 'Queue' ;
		this.sqlite = config.sqlite;
		this.connectedMatch = config.connected;
		this.connectedMatchType = config.connectedType;
		this.disconnectedMatch = config.disconnected;
		this.disconnectedMatchType = config.disconnectedType;

		/**
		 * Node Red Status Message
		 * @typedef {Object} NodeStatus
		 * @property {string} fill Colour of the status icon
		 * @property {string} shape Shape of icon whether ring or dot
		 * @property {string} text Text explaining status
		 */

		/**
		 * Instance of this node
		 * @type {QueueNode}
		 */
		var node = this;

		/**
		 * The status of the connection for the downstream node
		 * @type {boolean} isConnected === true, otherwise false
		 */
		var isConnected = false;

		/**
		 * Store status msg object received while sqlite waiting on I/O opening the DB
		 * @type {Array}
		 */
		var initStateMsgs = [] ;

		/**
		 * Store msg objects received while sqlite waiting on I/O opening the DB
		 * @type {Array}
		 */
		var initMsgs = [] ;

		/**
		 * Function that is called every second to update the status of the node
		 * @type {Function}
		 */
		var statusTimer = null ;

		/**
		 * Copy of last status message sent - if new status is different then send
		 * @type {NodeStatus}
		 */
		var status = {} ;

		// Generate error if filename to sqlite db not provided
		if(node.sqlite === undefined || node.sqlite == '') {
			node.error("No filename specified for the queue SQLite DB") ;
		}

		/**
		 * Queue
		 * @type {PersistentQueue}
		 */
		var queue = new Queue(this.sqlite) ;

		// Send messages from the queue downstream
		queue.on('next',function(msg) 
		{
			if(typeof(msg) !== "undefined")
				node.send(msg.job);
			queue.done() ;
		}) ;

		// Log when messages are being sent from queue
		queue.on('start',function() {
			if(!queue.isEmpty()) {
				statusOutput();
			}
			setStatusTimer() ;
			node.log('Processing messages in queue') ;
		}) ;

		// Log when messages being stored in queue
		queue.on('stop',function() {
			setStatusTimer() ;
			node.log('Queue processing stopped') ;
		}) ;

		// Log when queue is empty
		queue.on('empty',function() {
			statusOutput() ;
			setStatusTimer() ;
			node.log('Queue now empty') ;
		}) ;

		queue.on('add',function(msg) {
			setStatusTimer() ;
		}) ;

		// On node close, close the queue
		node.on('close', function (done) {
			if(statusTimer) {
				clearInterval(statusTimer) ;
				statusTimer = null ;
			}

			if(queue.isOpen()) {
				queue.close()
				.then(function() {
					done() ;
				})
				.catch(function(err) {
					done(err) ;
				}) ;
			} else {
				done() ;
			}
		});

		// Temporary event handler for processing messages while sqlite still opening DB
		// This prevents race conditions from occurring and messages being lost during the asynchronous
		// call of sqlite opening the db file
		node.on('input',initialState) ;

		/**
		 * Start/stop sending node status updates based on state of node
		 *
		 * If downstream node is disconnected or its connected but the queue isnt empty
		 * then we will send status updates for our node reflecting the change in number
		 * of msgs in the queue
		 *
		 * Otherwise, we stop updating our status (as the number of msgs wont change)
		 */
		function setStatusTimer() {
			if(!isConnected || isConnected && !queue.isEmpty()) {
				if(!statusTimer)
					statusTimer = setInterval(statusOutput,500) ;
			} else if(statusTimer) {
				clearInterval(statusTimer) ;
				statusTimer = null ;
			}
		}

		/**
		 * Function that outputs the status of the node on a timer
		 */
		function statusOutput() {
			// set status to: processing, storing, bypassing
			// processing = Green/Ring
			// !queue.isEmpty() && isConnected
			//
			// storing = Yellow/Ring
			// !isConnected
			//
			// forwarding = Green/Dot
			// queue.isEmpty() && isConnected
			var s ;
			var remaining = " (" + queue.getLength() + ")" ;

			if(!queue.isEmpty() && isConnected) {
				s = {
					fill:"green", shape:"ring", text:"Processing" + remaining
				} ;
			}
			else if(queue.isEmpty() && isConnected) {
				s = {
					fill:"green", shape:"dot", text:"Forwarding" + remaining
				} ;
			}
			else if(!isConnected) {
				s = {
					fill:"yellow", shape:"ring", text:"Storing" + remaining
				} ;
			}
			// Only update our status if it has changed
			if(!shallowequal(s,status))
				node.status(s) ;

			status = s ;
		}

		/**
		 * Store the latest 'status' message during initialisation of node
		 *
		 * Store the latest 'status' message while waiting for sqlite to open the db file.
		 *
		 * @param msg Messages received while sqlite still initialising
		 */
		function initialState(msg) {
			if (msg.hasOwnProperty('status'))
				initStateMsgs.push(msg) ;
			else
				initMsgs.push(msg) ;
		}


		/**
		 * This function is called when the status changes to connected = true
		 */
		function connected() {
			if(!isConnected) {
				isConnected = true ;
				if(!queue.isStarted()) {
					queue.start() ;
				}
			}
		}

		/**
		 * This function is called when the status changes to connected = false
		 */
		function disconnected() {
			if(isConnected) {
				isConnected = false;
				if(queue.isStarted()) {
					queue.stop() ;
				}
			}
		}

		function openDb()
		{
			queue.open()
			.then(function() {
				node.log("Opened " + node.sqlite + " successfully.") ;
			})
			.catch(function(err) {
				node.error("Queue failed to open " + node.sqlite, err);
				openDb();
				// @todo Check does this handle sqlite open error condition accordingly to node-red framework
			}) ;

		}

		/**
		 * Determine the status based on 'status' msg
		 *
		 * This function is passed a msg object with a 'status' property and processes it to determine
		 * whether the status is connected or not according to the user configuration
		 *
		 * @param {Object} msg Message passed from upstream nodes
		 * @param {Object} msg.status The status of the downstream node
		 */
		function processStatus(msg) {
			// Remove the prefix from status message
			var status = msg.status.text.toString().replace(/^node-red:common\.status\./,'') ;

			// if provided connection string or re match, test it
			if(node.connectedMatch !== ''
				&& node.connectedMatchType == 'str'
				&& status.includes(node.connectedMatch)
				|| node.connectedMatch !== ''
				&& node.connectedMatchType == 're'
				&& status.match(node.connectedMatch)
			) {
				//if (node.connectedMatch && msg.status.text.includes(node.connectedMatch)) {
				connected() ;
			}
			// if connected doesnt match, and disconnected string or re match provided, test that
			else if(node.disconnectedMatch !== ''
				&& node.disconnectedMatchType == 'str'
				&& status.includes(node.disconnectedMatch)
				|| node.disconnectedMatch !== ''
				&& node.disconnectedMatchType == 're'
				&& status.match(node.disconnectedMatch)
			) {
				disconnected() ;
			}
			// if status isn't explicitly matching a disconnected state, then if connection match not provided
			// assume we are connected
			else if(node.connectedMatch === '') {
				connected() ;
			}
			// otherwise, check if a disconnect match is provide, if so, we must be disconnected
			// otherwise, nothing matches this status, so ignore
			else if(node.disconnectedMatch === '') {
				disconnected() ;
			}
			// status message update
			statusOutput() ;
		}

		// Open the database
		openDb();

		// Once the sqlite db is open, set our event handlers for messages
		queue.on('open',function() {
			node.removeListener('input',initialState) ; // Initial state listener not needed now

			// Add these initial messages to the queue, so we can be sure they are passed on first, no matter
			// what the initial state of the queue is
			if(initMsgs.length > 0) {
				initMsgs.forEach(function(m){queue.add(m);}) ;
				initMsgs = [] ;
			}

			if(initStateMsgs.length > 0) { // If we received status messages during initialisation, process them now
				initStateMsgs.forEach(function(m){processStatus(m);}) ;
				initStateMsgs = [] ; // Reset it back to empty
			}

			// Update our node status after db opened
			statusOutput() ;

			// Once the queue has been opened, we can start listening for input from node-red
			node.on('input', function (msg) {

				// status message
				if (msg.hasOwnProperty('status')) {
					processStatus(msg) ;
					return ;
				}

				// upstream message to send on
				if(isConnected && queue.isEmpty()) {
						node.send(msg);
				} else {
					queue.add(msg) ;
				}
			});
		}) ;
	}
	RED.nodes.registerType('queue', QueueNode);
};
