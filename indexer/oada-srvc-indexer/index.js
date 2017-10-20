/* Copyright 2017 Open Ag Data Alliance
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const debug = require('debug');
const warn = debug('indexer:trace');
const trace = debug('indexer:trace');
const info = debug('indexer:info');
const error = debug('indexer:error');
const uuid = require('uuid')

const Promise = require('bluebird');
const _ = require('lodash')
const {Requester, Responder} = require('../../libs/oada-lib-kafka');
const oadaLib = require('../../libs/oada-lib-arangodb');
const config = require('./config');
const axios = require('axios')

//---------------------------------------------------------
// Kafka intializations:
const requester = new Requester(
			config.get('kafka:topics:httpResponse'),
			config.get('kafka:topics:writeRequest'),
			'indexer1');

const responder = new Responder(
	config.get('kafka:topics:httpResponse'),
	null,
			'indexer2');

module.exports = function stopResp() {
  return responder.disconnect(); 
};



function initializeIndexer(res, userid) {
	return {
		'resource_id': res._id,
		'path_leftover': `/_meta/trellis/client-to-certifications/`,
		'user_id': userid,
		'contentType': res._type,
		//		'connection_id': null,
		'indexer': true,
		'body': {
			[userid]: {isInitialized: true}
		}
	}
}

responder.on('request', function handleReq(req) {
	trace('write-response?', req.msgtype === 'write-response', 'success?', req.code ==='success')
	if (req.msgtype !== 'write-response') return
	if (req.code !== 'success') return
	trace('INDEXER', req.indexer)
	if (req.indexer) return
	trace('request: ', req)
	return oadaLib.resources.getResource(req.resource_id).then((res) => {
		if (res._type !== 'application/vnd.fpad.certifications.globalgap.1+json') return
		trace('res', res)
		var to_reindex;
		if (res._type === 'application/vnd.fpad.client.1+json') {
			if (!(res._meta._changes[res._rev].merge.certifications || res._meta._changes[res._rev].merge._meta._permissions)) return
			to_reindex = res.certifications._id
		} else {
			to_reindex = res._id
		}
		return oadaLib.resources.getResource(to_reindex).then((result) => {
			let newCerts = {}
			let writes = []
			// Check owner for any necessary writes and reindexes  
			if (res._meta.trellis && res._meta.trellis['client-to-certifications'][res._meta._owner]) {
				newCerts = result._meta._changes[result._rev].merge;
			} else {
				newCerts = result
				writes.push(initializeIndexer(res, res._meta._owner))
			}
			let owner = findNewCertifications(newCerts, res._meta._owner).then((write) => {
				return writes.push(...write)
			})
			// Check other permissioned users for any writes and reindexes needed
			trace('res._meta._permissions', res._meta._permissions)
			let other_users = Promise.map(Object.keys(res._meta._permissions || {}), (id) => {
				// If this user hasn't been indexed before, all certifications are "new", else use only recent _changes
				if (res._meta.trellis && res._meta.trellis['client-to-certifications'][id]) {
					newCerts = result._meta._changes[result._rev].merge;
				} else {
					newCerts = result;
					writes.push(initializeIndexer(res, id));
				}
				return findNewCertifications(newCerts, id).then((write) => {
					return writes.push(...write)
				})
			})
		 // Combine all of the resolved write requests into a single array to return
			return Promise.join(owner, other_users, ()=> {})
			.then((result) => {
				trace('WRITES', writes)
				return Promise.map(writes, (write) => {
					return requester.send(write)
						.catch(Promise.TimeoutError, (err) => {
							trace(err, write)
						})
				}).return(undefined)
			})
		})
	})
})

function findNewCertifications(newCerts, id,) {
	trace('re-indexing for user: ', id)
	return oadaLib.users.findById(id).then((user) => {
		// Define all of the resources and links that MAY be necessary.
		// They may be trimmed down below.
		let certifications = {
			'resource_id': '',
			'path_leftover': '/resources/'+uuid.v4(),
			'user_id': user._id,
			'contentType': 'application/vnd.fpad.certifications.globalgap.1+json',
			//			'connection_id': null,
			'indexer': true,
		}
		certifications.body = {
			_type: 'application/vnd.fpad.certifications.globalgap.1+json',
			_id: certifications.path_leftover.replace(/^\//, ''),
			_rev: '0-0',
		}
		Object.keys(newCerts).forEach((key) => {
			if (key.charAt(0) !== '_') {
  			certifications.body[key] = { 
					_id: newCerts[key]._id,
					_rev: newCerts[key]._rev
				}
			}
		})
		let fpad = {
			'resource_id': '',
			'path_leftover': '/resources/'+uuid.v4(),
			'user_id': user._id,
			'contentType': 'application/vnd.fpad.1+json',
			//			'connection_id': null,
			'indexer': true,
		}
		fpad.body = {
			_type: 'application/vnd.fpad.1+json',
			_id: fpad.path_leftover.replace(/^\//, ''),
			_rev: '0-0',
			certifications: {
				_id: certifications.body._id,
				_rev: certifications.body._rev 
			}
		}
		let bookmarks = {
			'resource_id': user.bookmarks._id,
			'path_leftover': '',
			'user_id': user._id,
			'contentType': 'application/vnd.oada.bookmarks.1+json',
			//			'connection_id': null,
			'indexer': true,
		}
		bookmarks.body = {
			fpad: {
				_id: fpad.body._id,
				_rev: fpad.body._rev
			}
		}
    trace('FPAD RESOURCE', fpad)
    trace('CERTIFICATIONS RESOURCE', certifications)
    trace('BOOKMARKS RESOURCE', bookmarks)
		return oadaLib.resources.lookupFromUrl('/'+user.bookmarks._id+'/fpad/certifications', user._id).then((result) => {
			trace('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~')
			trace('lookupUrl result: ', result)
			if (result.path_leftover === '') { // fpad and certifications exist
				certifications.path_leftover = ''
				certifications.resource_id = result.resource_id
				certifications.contentType = 'application/vnd.fpad.certifications.globalgap.1+json';
				delete certifications.body._id
				delete certifications.body._rev
				trace('GETreSource', result.resource_id)
				return oadaLib.resources.getResource(result.resource_id).then((curCerts) => {
					let reset_type = false;
					if (curCerts._type === 'application/vnd.fpad.certifications.globalgap.1+json') {
						delete certifications.body._type
					} else {
						certifications.body._type = 'application/vnd.fpad.certifications.globalgap.1+json'
					}
					trace('Current CERTS', curCerts)
					trace('New CERTS', newCerts)
					// Prune off the certifications that have already been re-indexed
					Object.keys(newCerts).forEach((key) => {
						if (key.charAt(0) !== '_') {
							if (curCerts[key]) {
								delete certifications.body[key];
								trace('cert already exists', certifications.body[key])
							}
						}
					})
  				trace('1', certifications.body)
					if (_.isEmpty(certifications.body) && reset_type) return []
					return [certifications]
				})
			} else if (/\/fpad/.test(result.path_leftover)) {
			// neither fpad nor certifications exist
				trace('2', [certifications, fpad, bookmarks])
				return [fpad, bookmarks, certifications ]
			} else {
			// fpad exists, certifications doesn't exist
				delete fpad.body._id
				delete fpad.body._rev
				delete fpad.body._type
				fpad.resource_id = result.resource_id
				fpad.path_leftover= '' 
				trace('3', [certifications, fpad])
				return [fpad, certifications]
			}
			return
		})
	})
}
