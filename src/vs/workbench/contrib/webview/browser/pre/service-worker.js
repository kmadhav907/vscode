/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

/// <reference no-default-lib="true"/>
/// <reference lib="webworker" />

const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {any} */ (self));

const VERSION = 3;

const resourceCacheName = `vscode-resource-cache-${VERSION}`;

const rootPath = sw.location.pathname.replace(/\/service-worker.js$/, '');

const searchParams = new URL(location.toString()).searchParams;

/**
 * Origin used for resources
 */
const resourceBaseAuthority = searchParams.get('vscode-resource-base-authority');

const resolveTimeout = 30000;

/**
 * @template T
 * @typedef {{
 *     resolve: (x: T) => void,
 *     promise: Promise<T>
 * }} RequestStoreEntry
 */

/**
 * Caches
 * @template T
 */
class RequestStore {
	constructor() {
		/** @type {Map<number, RequestStoreEntry<T>>} */
		this.map = new Map();

		this.requestPool = 0;
	}

	/**
	 * @param {number} requestId
	 * @return {Promise<T> | undefined}
	 */
	get(requestId) {
		const entry = this.map.get(requestId);
		return entry && entry.promise;
	}

	/**
	 * @returns {{ requestId: number, promise: Promise<T> }}
	 */
	create() {
		const requestId = ++this.requestPool;

		/** @type {undefined | ((x: T) => void)} */
		let resolve;

		/** @type {Promise<T>} */
		const promise = new Promise(r => resolve = r);

		/** @type {RequestStoreEntry<T>} */
		const entry = { resolve: /** @type {(x: T) => void} */ (resolve), promise };

		this.map.set(requestId, entry);

		const dispose = () => {
			clearTimeout(timeout);
			const existingEntry = this.map.get(requestId);
			if (existingEntry === entry) {
				return this.map.delete(requestId);
			}
		};
		const timeout = setTimeout(dispose, resolveTimeout);
		return { requestId, promise };
	}

	/**
	 * @param {number} requestId
	 * @param {T} result
	 * @return {boolean}
	 */
	resolve(requestId, result) {
		const entry = this.map.get(requestId);
		if (!entry) {
			return false;
		}
		entry.resolve(result);
		this.map.delete(requestId);
		return true;
	}
}

/**
 * @typedef {{ readonly status: 200; id: number; path: string; mime: string; data: Uint8Array; etag: string | undefined; mtime: number | undefined; }
 * 		| { readonly status: 304; id: number; path: string; mime: string; mtime: number | undefined }
 *		| { readonly status: 401; id: number; path: string }
 *		| { readonly status: 404; id: number; path: string }} ResourceResponse
 */

/**
 * Map of requested paths to responses.
 *
 * @type {RequestStore<ResourceResponse>}
 */
const resourceRequestStore = new RequestStore();

/**
 * Map of requested localhost origins to optional redirects.
 *
 * @type {RequestStore<string | undefined>}
 */
const localhostRequestStore = new RequestStore();

const notFound = () =>
	new Response('Not Found', { status: 404, });

const methodNotAllowed = () =>
	new Response('Method Not Allowed', { status: 405, });

const vscodeMessageChannel = new MessageChannel();

sw.addEventListener('message', event => {
	switch (event.data.channel) {
		case 'init':
			{
				const source = /** @type {Client} */ (event.source);
				sw.clients.get(source.id).then(client => {
					client?.postMessage({
						channel: 'init',
						version: VERSION
					}, [vscodeMessageChannel.port2]);
				});
				return;
			}
	}

	console.log('Unknown message');
});

vscodeMessageChannel.port1.onmessage = (event) => {
	switch (event.data.channel) {
		case 'did-load-resource':
			{

				/** @type {ResourceResponse} */
				const response = event.data;
				if (!resourceRequestStore.resolve(response.id, response)) {
					console.log('Could not resolve unknown resource', response.path);
				}
				return;
			}
		case 'did-load-localhost':
			{
				const data = event.data;
				if (!localhostRequestStore.resolve(data.id, data.location)) {
					console.log('Could not resolve unknown localhost', data.origin);
				}
				return;
			}
	}

	console.log('Unknown message');
};

sw.addEventListener('fetch', (event) => {
	const requestUrl = new URL(event.request.url);
	if (requestUrl.protocol === 'https:' && requestUrl.hostname.endsWith('.' + resourceBaseAuthority)) {
		switch (event.request.method) {
			case 'GET':
			case 'HEAD':
				return event.respondWith(processResourceRequest(event, requestUrl));

			default:
				return event.respondWith(methodNotAllowed());
		}
	}

	// See if it's a localhost request
	if (requestUrl.origin !== sw.origin && requestUrl.host.match(/^(localhost|127.0.0.1|0.0.0.0):(\d+)$/)) {
		return event.respondWith(processLocalhostRequest(event, requestUrl));
	}
});

sw.addEventListener('install', (event) => {
	event.waitUntil(sw.skipWaiting());
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(sw.clients.claim()); // Become available to all pages
});

/**
 * @param {FetchEvent} event
 * @param {URL} requestUrl
 */
async function processResourceRequest(event, requestUrl) {
	const shouldTryCaching = (event.request.method === 'GET');

	/**
	 * @param {ResourceResponse} entry
	 * @param {Response | undefined} cachedResponse
	 */
	const resolveResourceEntry = (entry, cachedResponse) => {
		if (entry.status === 304) { // Not modified
			if (cachedResponse) {
				return cachedResponse.clone();
			} else {
				throw new Error('No cache found');
			}
		}

		if (entry.status !== 200) {
			return notFound();
		}

		/** @type {Record<string, string>} */
		const headers = {
			'Content-Type': entry.mime,
			'Content-Length': entry.data.byteLength.toString(),
			'Access-Control-Allow-Origin': '*',
		};
		if (entry.etag) {
			headers['ETag'] = entry.etag;
			headers['Cache-Control'] = 'no-cache';
		}
		if (entry.mtime) {
			headers['Last-Modified'] = new Date(entry.mtime).toUTCString();
		}
		const response = new Response(entry.data, {
			status: 200,
			headers
		});

		if (shouldTryCaching && entry.etag) {
			caches.open(resourceCacheName).then(cache => {
				return cache.put(event.request, response);
			});
		}
		return response.clone();
	};

	/** @type {Response | undefined} */
	let cached;
	if (shouldTryCaching) {
		const cache = await caches.open(resourceCacheName);
		cached = await cache.match(event.request);
	}

	const { requestId, promise } = resourceRequestStore.create();

	const firstHostSegment = requestUrl.hostname.slice(0, requestUrl.hostname.length - (resourceBaseAuthority.length + 1));
	const scheme = firstHostSegment.split('+', 1)[0];
	const authority = firstHostSegment.slice(scheme.length + 1); // may be empty

	vscodeMessageChannel.port1.postMessage({
		channel: 'load-resource',
		id: requestId,
		path: requestUrl.pathname,
		scheme,
		authority,
		query: requestUrl.search.replace(/^\?/, ''),
		ifNoneMatch: cached?.headers.get('ETag'),
	});

	return promise.then(entry => resolveResourceEntry(entry, cached));
}

/**
 * @param {FetchEvent} event
 * @param {URL} requestUrl
 * @return {Promise<Response>}
 */
async function processLocalhostRequest(event, requestUrl) {
	const client = await sw.clients.get(event.clientId);
	if (!client) {
		// This is expected when requesting resources on other localhost ports
		// that are not spawned by vs code
		return fetch(event.request);
	}

	const origin = requestUrl.origin;

	/**
	 * @param {string | undefined} redirectOrigin
	 * @return {Promise<Response>}
	 */
	const resolveRedirect = async (redirectOrigin) => {
		if (!redirectOrigin) {
			return fetch(event.request);
		}
		const location = event.request.url.replace(new RegExp(`^${requestUrl.origin}(/|$)`), `${redirectOrigin}$1`);
		return new Response(null, {
			status: 302,
			headers: {
				Location: location
			}
		});
	};

	const { requestId, promise } = localhostRequestStore.create();

	vscodeMessageChannel.port1.postMessage({
		channel: 'load-localhost',
		origin: origin,
		id: requestId,
	});

	return promise.then(resolveRedirect);
}
