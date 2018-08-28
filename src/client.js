/*
 * ACME client
 */

const crypto = require('crypto');
const debug = require('debug')('acme-client');
const Promise = require('bluebird');
const HttpClient = require('./http');
const AcmeApi = require('./api');
const openssl = require('./openssl');
const verify = require('./verify');
const helper = require('./helper');
const auto = require('./auto');


/*
 * Default options
 */

const defaultOpts = {
    directoryUrl: undefined,
    accountKey: undefined,
    backoffAttempts: 5,
    backoffMin: 5000,
    backoffMax: 30000
};


/**
 * AcmeClient
 *
 * @class
 * @param {object} opts
 * @param {string} opts.directoryUrl ACME directory URL
 * @param {buffer|string} opts.accountKey PEM encoded account private key
 * @param {number} [opts.backoffAttempts] Maximum number of backoff attempts, default: `5`
 * @param {number} [opts.backoffMin] Minimum backoff attempt delay in milliseconds, default: `5000`
 * @param {number} [opts.backoffMax] Maximum backoff attempt delay in milliseconds, default: `30000`
 */

class AcmeClient {
    constructor(opts) {
        if (!Buffer.isBuffer(opts.accountKey)) {
            opts.accountKey = Buffer.from(opts.accountKey);
        }

        this.opts = Object.assign({}, defaultOpts, opts);

        this.backoffOpts = {
            attempts: this.opts.backoffAttempts,
            min: this.opts.backoffMin,
            max: this.opts.backoffMax
        };

        this.http = new HttpClient(this.opts.directoryUrl, this.opts.accountKey);
        this.api = new AcmeApi(this.http);
    }


    /**
     * Get Terms of Service URL
     *
     * @returns {Promise<string>} ToS URL
     */

    getTermsOfServiceUrl() {
        return this.api.getTermsOfServiceUrl();
    }


    /**
     * Create a new account
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#account-creation
     *
     * @param {object} [data] Request data
     * @returns {Promise<object>} Account
     */

    async createAccount(data = {}) {
        const resp = await this.api.createAccount(data);

        /* HTTP 200: Account exists */
        if (resp.statusCode === 200) {
            debug('Account already exists (HTTP 200), returning updateAccount()');
            return this.updateAccount(data);
        }

        return resp.body;
    }


    /**
     * Update existing account
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#account-update
     *
     * @param {object} [data] Request data
     * @returns {Promise<object>} Account
     */

    async updateAccount(data = {}) {
        try {
            this.api.getAccountUrl();
        }
        catch (e) {
            debug('No account URL found, returning createAccount()');
            return this.createAccount(data);
        }

        const resp = await this.api.updateAccount(data);
        return resp.body;
    }


    /**
     * Update account private key
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#account-key-roll-over
     *
     * @param {buffer|string} newAccountKey New PEM encoded private key
     * @param {object} [data] Additional request data
     * @returns {Promise<object>} Account
     */

    async updateAccountKey(newAccountKey, data = {}) {
        if (!Buffer.isBuffer(newAccountKey)) {
            newAccountKey = Buffer.from(newAccountKey);
        }

        const accountUrl = this.api.getAccountUrl();

        /* Create new HTTP and API clients using new key */
        const newHttpClient = new HttpClient(this.opts.directoryUrl, newAccountKey);
        const newApiClient = new AcmeApi(newHttpClient, accountUrl);

        /* Get new JWK */
        data.account = accountUrl;
        data.newKey = await newHttpClient.getJwk();

        /* Get signed request body from new client */
        const url = await newHttpClient.getResourceUrl('keyChange');
        const body = await newHttpClient.createSignedBody(url, data);

        /* Change key using old client */
        const resp = await this.api.updateAccountKey(body);

        /* Replace existing HTTP and API client */
        this.http = newHttpClient;
        this.api = newApiClient;

        return resp.body;
    }


    /**
     * Create a new order
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#applying-for-certificate-issuance
     *
     * @param {object} data Request data
     * @returns {Promise<object>} Order
     */

    async createOrder(data) {
        const resp = await this.api.createOrder(data);

        if (!resp.headers.location) {
            throw new Error('Creating a new order did not return an order link');
        }

        /* Add URL to response */
        resp.body.url = resp.headers.location;
        return resp.body;
    }


    /**
     * Finalize order
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#applying-for-certificate-issuance
     *
     * @param {object} order Order object
     * @param {buffer|string} csr PEM encoded Certificate Signing Request
     * @returns {Promise<object>} Order
     */

    async finalizeOrder(order, csr) {
        if (!order.finalize) {
            throw new Error('Unable to finalize order, URL not found');
        }

        if (!Buffer.isBuffer(csr)) {
            csr = Buffer.from(csr);
        }

        const der = await openssl.pem2der(csr);
        const data = { csr: helper.b64encode(der) };

        const resp = await this.api.finalizeOrder(order.finalize, data);
        return resp.body;
    }


    /**
     * Get identifier authorizations from order
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#identifier-authorization
     *
     * @param {object} order Order
     * @returns {Promise<object[]>} Authorizations
     */

    getAuthorizations(order) {
        return Promise.map((order.authorizations || []), async (url) => {
            const resp = await this.api.getAuthorization(url);

            /* Add URL to response */
            resp.body.url = url;
            return resp.body;
        });
    }


    /**
     * Deactivate identifier authorization
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#deactivating-an-authorization
     *
     * @param {object} authz Identifier authorization
     * @returns {Promise<object>} Authorization
     */

    async deactivateAuthorization(authz) {
        if (!authz.url) {
            throw new Error('Unable to deactivate identifier authorization, URL not found');
        }

        const data = {
            status: 'deactivated'
        };

        const resp = await this.api.updateAuthorization(authz.url, data);
        return resp.body;
    }


    /**
     * Get key authorization for ACME challenge
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#key-authorizations
     *
     * @param {object} challenge Challenge object returned by API
     * @returns {Promise<string>} Key authorization
     */

    async getChallengeKeyAuthorization(challenge) {
        const jwk = await this.http.getJwk();
        const keysum = crypto.createHash('sha256').update(JSON.stringify(jwk));
        const thumbprint = helper.b64escape(keysum.digest('base64'));
        const result = `${challenge.token}.${thumbprint}`;

        if (challenge.type === 'http-01') {
            /* https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#http-challenge */
            return result;
        }
        else if (challenge.type === 'dns-01') {
            /* https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#dns-challenge */
            const shasum = crypto.createHash('sha256').update(result);
            return helper.b64escape(shasum.digest('base64'));
        }
        else if (challenge.type === 'tls-alpn-01') {
            return result;
        }

        throw new Error(`Unable to produce key authorization, unknown challenge type: ${challenge.type}`);
    }


    /**
     * Verify that ACME challenge is satisfied
     *
     * @param {object} authz Identifier authorization
     * @param {object} challenge Authorization challenge
     * @returns {Promise}
     */

    async verifyChallenge(authz, challenge, challengeKeyAuthorization) {
        if (!authz.url || !challenge.url) {
            throw new Error('Unable to verify ACME challenge, URL not found');
        }

        if (typeof verify[challenge.type] === 'undefined') {
            throw new Error(`Unable to verify ACME challenge, unknown type: ${challenge.type}`);
        }

        // TODO Remove this since we will be providing the challenge token
        // const keyAuthorization = await this.getChallengeKeyAuthorization(challenge);

        const verifyFn = async () => {
            await verify[challenge.type](authz, challenge, challengeKeyAuthorization);
        };

        // debug('Waiting for ACME challenge verification', this.backoffOpts);
        // return helper.retry(verifyFn, this.backoffOpts);
    }


    /**
     * Notify provider that challenge has been completed
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#responding-to-challenges
     *
     * @param {object} challenge Challenge object returned by API
     * @returns {Promise<object>} Challenge
     */
    async completeChallenge(challenge) {
        const data = {
            keyAuthorization: await this.getChallengeKeyAuthorization(challenge)
        };

        const resp = await this.api.completeChallenge(challenge.url, data);
        return resp.body;
    }


    /**
     * Wait for ACME provider to verify status on a order, authorization or challenge
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#responding-to-challenges
     *
     * @param {object} item An order, authorization or challenge object
     * @returns {Promise<object>} Valid order, authorization or challenge
     */
    async waitForValidStatus(item) {
        if (!item.url) {
            throw new Error('Unable to verify status of item, URL not found');
        }

        const verifyFn = async (abort) => {
            const resp = await this.api.get(item.url, [200]);

            /* Verify status */
            debug(`Item has status: ${resp.body.status}`);

            if (resp.body.status === 'invalid') {
                abort();
                throw new Error(helper.formatResponseError(resp));
            }
            else if (resp.body.status === 'pending') {
                throw new Error('Operation is pending');
            }
            else if (resp.body.status === 'valid') {
                return resp.body;
            }

            throw new Error(`Unexpected item status: ${resp.body.status}`);
        };

        debug(`Waiting for valid status from: ${item.url}`, this.backoffOpts);
        return helper.retry(verifyFn, this.backoffOpts);
    }


    /**
     * Get certificate from ACME order
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#downloading-the-certificate
     *
     * @param {object} order Order object
     * @returns {Promise<buffer>} Certificate
     */

    async getCertificate(order) {
        if (order.status !== 'valid') {
            order = await this.waitForValidStatus(order);
        }

        if (!order.certificate) {
            throw new Error('Unable to download certificate, URL not found');
        }

        const resp = await this.http.request(order.certificate, 'GET', { encoding: null });
        return resp.body;
    }


    /**
     * Revoke certificate
     *
     * https://github.com/ietf-wg-acme/acme/blob/master/draft-ietf-acme-acme.md#certificate-revocation
     *
     * @param {buffer|string} cert PEM encoded certificate
     * @param {object} [data] Additional request data
     * @returns {Promise}
     */

    async revokeCertificate(cert, data = {}) {
        const der = await openssl.pem2der(cert);
        data.certificate = helper.b64encode(der);

        const resp = await this.api.revokeCert(data);
        return resp.body;
    }


    /**
     * Auto mode
     *
     * @param {object} opts
     * @param {buffer|string} opts.csr Certificate Signing Request
     * @param {function} opts.challengeCreateFn Function returning Promise triggered before completing ACME challenge
     * @param {function} opts.challengeRemoveFn Function returning Promise triggered after completing ACME challenge
     * @param {string} [opts.email] Account email address
     * @param {boolean} [opts.termsOfServiceAgreed] Agree to Terms of Service, default: `false`
     * @param {string[]} [opts.challengePriority] Array defining challenge type priority, default: `['http-01', 'dns-01']`
     * @returns {Promise<buffer>} Certificate
     */

    auto(opts) {
        return auto(this, opts);
    }
}


/* Export client */
module.exports = AcmeClient;
