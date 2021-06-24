/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { CryptoOps } from "./CryptoOps";
import { PopTokenGenerator } from "@azure/msal-common";

export class SignedHttpRequest {
    private popTokenGenerator: PopTokenGenerator;
    private cryptoOpts: CryptoOps;
    private resourceRequestUri: string;
    private resourceRequestMethod: string;

    constructor(resourceRequestUri: string, resourceRequestMethod: string) {
        this.cryptoOpts = new CryptoOps();
        this.popTokenGenerator = new PopTokenGenerator(this.cryptoOpts);
        this.resourceRequestUri = resourceRequestUri;
        this.resourceRequestMethod = resourceRequestMethod;
    }

    /**
     * Generates and caches a keypair for the given request options.
     * @returns Public key digest, which should be sent to the token issuer.
     */
    async generatePublicKey(): Promise<string> {
        const { kid } = await this.popTokenGenerator.generateKid({
            resourceRequestMethod: this.resourceRequestMethod,
            resourceRequestUri: this.resourceRequestUri
        });

        return kid;
    }

    /**
     * Generates a signed http request for the given payload with the given key.
     * @param payload Payload to sign (e.g. access token)
     * @param publicKey Public key digest (from generatePublicKey API)
     * @param claims Additional claims to include/override in the signed JWT 
     * @returns Pop token signed with the corresponding private key
     */
    async signPopToken(payload: string, publicKey: string, claims?: object): Promise<string> {
        return this.popTokenGenerator.signPayload(
            payload, 
            publicKey,
            {
                resourceRequestMethod: this.resourceRequestMethod, 
                resourceRequestUri: this.resourceRequestUri
            }, 
            claims
        );
    }
}
