/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { BaseAuthRequest, ICrypto, PkceCodes, SignedHttpRequest, ServerAuthorizationTokenResponse, BoundServerAuthorizationTokenResponse, CommonRefreshTokenRequest } from "@azure/msal-common";
import { GuidGenerator } from "./GuidGenerator";
import { Base64Encode } from "../encode/Base64Encode";
import { Base64Decode } from "../encode/Base64Decode";
import { PkceGenerator } from "./PkceGenerator";
import { CtxGenerator } from "./CtxGenerator";
import { BrowserCrypto } from "./BrowserCrypto";
import { DatabaseStorage } from "../cache/DatabaseStorage";
import { BrowserStringUtils } from "../utils/BrowserStringUtils";
import { BROWSER_CRYPTO, CryptoKeyTypes, KEY_FORMAT_JWK, KEY_USAGES, KEY_DERIVATION_SIZES, KEY_DERIVATION_LABELS, DB_TABLE_NAMES } from "../utils/BrowserConstants";
import { BrowserAuthError } from "../error/BrowserAuthError";
import {JsonWebEncryption} from "./JsonWebEncryption";
import { KeyDerivation } from "./KeyDerivation";

// Public Exponent used in Key Generation
const PUBLIC_EXPONENT: Uint8Array = new Uint8Array([0x01, 0x00, 0x01]);

export type CachedKeyPair = {
    publicKey: CryptoKey,
    privateKey: CryptoKey,
    requestMethod?: string,
    requestUri?: string
};

export type CryptoKeyOptions = {
    keyGenAlgorithmOptions: RsaHashedKeyGenParams,
    keypairUsages: KeyUsage[],
    privateKeyUsage: KeyUsage[]
};

/**
 * This class implements MSAL's crypto interface, which allows it to perform base64 encoding and decoding, generating cryptographically random GUIDs and 
 * implementing Proof Key for Code Exchange specs for the OAuth Authorization Code Flow using PKCE (rfc here: https://tools.ietf.org/html/rfc7636).
 */
export class CryptoOps implements ICrypto {

    private browserCrypto: BrowserCrypto;
    private guidGenerator: GuidGenerator;
    private b64Encode: Base64Encode;
    private b64Decode: Base64Decode;
    private pkceGenerator: PkceGenerator;
    private ctxGenerator: CtxGenerator;
    private _atBindingKeyOptions: CryptoKeyOptions;
    private _rtBindingKeyOptions: CryptoKeyOptions;

    private static EXTRACTABLE: boolean = true;

    private static DB_VERSION = 1;
    private static DB_NAME = "msal.db";
    private static TABLE_NAMES = [DB_TABLE_NAMES.ASYMMETRIC_KEYS, DB_TABLE_NAMES.SYMMETRIC_KEYS];
    private cache: DatabaseStorage;

    constructor() {
        // Browser crypto needs to be validated first before any other classes can be set.
        this.browserCrypto = new BrowserCrypto();
        this.b64Encode = new Base64Encode();
        this.b64Decode = new Base64Decode();
        this.guidGenerator = new GuidGenerator(this.browserCrypto);
        this.pkceGenerator = new PkceGenerator(this.browserCrypto);
        this.ctxGenerator = new CtxGenerator(this.browserCrypto);
        this.cache = new DatabaseStorage(CryptoOps.DB_NAME, CryptoOps.TABLE_NAMES, CryptoOps.DB_VERSION);

        this._atBindingKeyOptions = {
            keyGenAlgorithmOptions: {
                name: BROWSER_CRYPTO.PKCS1_V15_KEYGEN_ALG,
                hash: {
                    name: BROWSER_CRYPTO.S256_HASH_ALG
                },
                modulusLength: BROWSER_CRYPTO.MODULUS_LENGTH,
                publicExponent: PUBLIC_EXPONENT
            },
            keypairUsages: KEY_USAGES.AT_BINDING.KEYPAIR as KeyUsage[],
            privateKeyUsage: KEY_USAGES.AT_BINDING.PRIVATE_KEY as KeyUsage[]
        };

        this._rtBindingKeyOptions = {
            keyGenAlgorithmOptions: {     
                name: BROWSER_CRYPTO.RSA_OAEP,
                hash: {
                    name: BROWSER_CRYPTO.S256_HASH_ALG
                },
                modulusLength: BROWSER_CRYPTO.MODULUS_LENGTH,
                publicExponent: PUBLIC_EXPONENT
            },
            keypairUsages: KEY_USAGES.RT_BINDING.KEYPAIR as KeyUsage[],
            privateKeyUsage: KEY_USAGES.RT_BINDING.PRIVATE_KEY as KeyUsage[]
        };
    }

    /**
     * Creates a new random GUID - used to populate state and nonce.
     * @returns string (GUID)
     */
    createNewGuid(): string {
        return this.guidGenerator.generateGuid();
    }

    /**
     * 
     * Creates a new random Ctx - used to derive Bound RT HMAC key.
     * @returns
     */
    createNewCtx(): Uint8Array {
        return this.ctxGenerator.generateCtx();
    }
    /**
     * Encodes input string to base64.
     * @param input 
     */
    base64Encode(input: string): string {
        return this.b64Encode.encode(input);
    }    
    
    /**
     * Decodes input string from base64.
     * @param input 
     */
    base64Decode(input: string): string {
        return this.b64Decode.decode(input);
    }

    /**
     * Generates PKCE codes used in Authorization Code Flow.
     */
    async generatePkceCodes(): Promise<PkceCodes> {
        return this.pkceGenerator.generateCodes();
    }

    /**
     * Generates a keypair, stores it and returns a thumbprint
     * @param request
     */
    async getPublicKeyThumbprint(request: BaseAuthRequest, keyType?: string): Promise<string> {
        let keyOptions: CryptoKeyOptions;

        switch(keyType) {
            case CryptoKeyTypes.stk_jwk:
                keyOptions = this._rtBindingKeyOptions;
                break;
            default:
                keyOptions = this._atBindingKeyOptions;
        }
        
        // Generate Keypair
        const keyPair = await this.browserCrypto.generateKeyPair(keyOptions, CryptoOps.EXTRACTABLE);

        // Generate Thumbprint for Public Key
        const publicKeyJwk: JsonWebKey = await this.browserCrypto.exportJwk(keyPair.publicKey);

        // Build JSON Web Key
        const pubKeyThumprintObj: JsonWebKey = {
            e: publicKeyJwk.e,
            kty: publicKeyJwk.kty,
            n: publicKeyJwk.n
        };

        const publicJwkString: string = BrowserCrypto.getJwkString(pubKeyThumprintObj);
        const publicJwkBuffer: ArrayBuffer = await this.browserCrypto.sha256Digest(publicJwkString);
        const publicJwkHash: string = this.b64Encode.urlEncodeArr(new Uint8Array(publicJwkBuffer));

        // Generate Thumbprint for Private Key
        const privateKeyJwk: JsonWebKey = await this.browserCrypto.exportJwk(keyPair.privateKey);
        // Re-import private key to make it unextractable
        const unextractablePrivateKey: CryptoKey = await this.browserCrypto.importJwk(keyOptions, privateKeyJwk, false, keyOptions.privateKeyUsage);

        // Store Keypair data in keystore
        this.cache.put<CachedKeyPair>(
            DB_TABLE_NAMES.ASYMMETRIC_KEYS,
            publicJwkHash, 
            {
                privateKey: unextractablePrivateKey,
                publicKey: keyPair.publicKey,
                requestMethod: request.resourceRequestMethod,
                requestUri: request.resourceRequestUri
            }
        );

        return publicJwkHash;
    }

    /**
     * Signs the given object as a jwt payload with private key retrieved by given kid.
     * @param payload 
     * @param kid 
     */
    async signJwt(payload: SignedHttpRequest, kid: string): Promise<string> {
        // Get keypair from cache
        const cachedKeyPair: CachedKeyPair = await this.cache.get<CachedKeyPair>(DB_TABLE_NAMES.ASYMMETRIC_KEYS, kid);

        // Get public key as JWK
        const publicKeyJwk = await this.browserCrypto.exportJwk(cachedKeyPair.publicKey);
        const publicKeyJwkString = BrowserCrypto.getJwkString(publicKeyJwk);

        // Generate header
        const header = {
            alg: publicKeyJwk.alg,
            type: KEY_FORMAT_JWK
        };
        const encodedHeader = this.b64Encode.urlEncode(JSON.stringify(header));

        // Generate payload
        payload.cnf = {
            jwk: JSON.parse(publicKeyJwkString)
        };
        const encodedPayload = this.b64Encode.urlEncode(JSON.stringify(payload));

        // Form token string
        const tokenString = `${encodedHeader}.${encodedPayload}`;

        // Sign token
        const tokenBuffer = BrowserStringUtils.stringToArrayBuffer(tokenString);
        const signatureBuffer = await this.browserCrypto.sign(this._atBindingKeyOptions, cachedKeyPair.privateKey, tokenBuffer);
        const encodedSignature = this.b64Encode.urlEncodeArr(new Uint8Array(signatureBuffer));

        return `${tokenString}.${encodedSignature}`;
    }

    /**
     * Returns the public key from an asymmetric key pair stored in IndexedDB based on the
     * public key thumbprint parameter
     * @param keyThumbprint 
     * @returns Public Key JWK string
     */
    async getAsymmetricPublicKey(keyThumbprint: string): Promise<string> {
        const cachedKeyPair: CachedKeyPair = await this.cache.get<CachedKeyPair>(DB_TABLE_NAMES.ASYMMETRIC_KEYS, keyThumbprint);
        // Get public key as JWK
        const publicKeyJwk = await this.browserCrypto.exportJwk(cachedKeyPair.publicKey);
        return BrowserCrypto.getJwkString(publicKeyJwk);
    }

    /**
     * Returns the decrypted server token response
     * @param boundServerTokenResponse 
     * @param request 
     */
    async decryptBoundTokenResponse(
        boundServerTokenResponse: BoundServerAuthorizationTokenResponse,
        request: BaseAuthRequest): Promise<ServerAuthorizationTokenResponse> {
            
        const kid = request.stkJwk;

        if (kid) {
            // Retrieve Session Transport KeyPair from Key Store
            const sessionTransportKeypair: CachedKeyPair = await this.cache.get<CachedKeyPair>(DB_TABLE_NAMES.ASYMMETRIC_KEYS, kid);

            // Deserialize session_key_jwe
            const sessionKeyJwe = new JsonWebEncryption(boundServerTokenResponse.session_key_jwe);
            
            // Deserialize response_jwe
            const responseJwe = new JsonWebEncryption(boundServerTokenResponse.response_jwe);
            
            // Unwrap content encryption key
            const derivationKeyUsage = KEY_USAGES.RT_BINDING.DERIVATION_KEY as KeyUsage[];
            const contentEncryptionKey = await sessionKeyJwe.unwrap(sessionTransportKeypair.privateKey, derivationKeyUsage);

            // Derive session key using content encryption key
            const kdf = new KeyDerivation(
                contentEncryptionKey,
                KEY_DERIVATION_SIZES.DERIVED_KEY_LENGTH,
                KEY_DERIVATION_SIZES.PRF_OUTPUT_LENGTH,
                KEY_DERIVATION_SIZES.COUNTER_LENGTH
            );

            // Encode context
            const ctxBytes = Uint8Array.from(window.atob(responseJwe.protectedHeader.ctx), (v) => v.charCodeAt(0));
            
            const derivedKeyData = new Uint8Array(await kdf.computeKDFInCounterMode(ctxBytes, KEY_DERIVATION_LABELS.DECRYPTION));
            const sessionKeyUsages = KEY_USAGES.RT_BINDING.SESSION_KEY as KeyUsage[];
            const sessionKeyAlgorithm: AesKeyAlgorithm = { name: "AES-GCM", length: 256 };
            const sessionKey = await window.crypto.subtle.importKey("raw", derivedKeyData, sessionKeyAlgorithm, false, sessionKeyUsages);

            // Decrypt response using derived key
            const responseStr = await responseJwe.decrypt(sessionKey);

            const response: ServerAuthorizationTokenResponse = JSON.parse(responseStr);
            await this.cache.put<CryptoKey>(DB_TABLE_NAMES.SYMMETRIC_KEYS, kid, contentEncryptionKey);
            
            return {
                ...response,
                stkKid: kid,
                skKid: kid
            };
        } else {
            throw BrowserAuthError.createMissingStkKidError();
        }
    }

    async signBoundTokenRequest(request: CommonRefreshTokenRequest, payload: string): Promise<string> {
        const { stkKid, skKid } = request;

        if (stkKid && skKid) {
            // Retrieve Session Transport KeyPair from Key Store
            const sessionTransportKeypair: CachedKeyPair = await this.cache.get<CachedKeyPair>(DB_TABLE_NAMES.ASYMMETRIC_KEYS, stkKid);

            // Retrieve Session Key from Key Store
            const contentEncryptionKey: CryptoKey = await this.cache.get<CryptoKey>(DB_TABLE_NAMES.SYMMETRIC_KEYS, skKid);
            
            // Derive session key using content encryption key
            const kdf = new KeyDerivation(
                contentEncryptionKey,
                KEY_DERIVATION_SIZES.DERIVED_KEY_LENGTH,
                KEY_DERIVATION_SIZES.PRF_OUTPUT_LENGTH,
                KEY_DERIVATION_SIZES.COUNTER_LENGTH
            );

            // Generate CTX
            const ctx = this.ctxGenerator.generateCtx();
            const payloadBytes = BrowserStringUtils.stringToUtf8Arr(JSON.stringify(payload));
            console.log("CTX: ", ctx);
            console.log("Payload: ", payloadBytes);
            const inputData = new Uint8Array(ctx.byteLength + payloadBytes.byteLength);

            inputData.set(ctx, 0);
            inputData.set(payloadBytes, ctx.byteLength);

            console.log("Concat: ", inputData);

            const hashedInputData = new Uint8Array(await window.crypto.subtle.digest({ name: "SHA-256" }, inputData));
            console.log("Hashed: ", hashedInputData);
            const derivedKeyData = new Uint8Array(await kdf.computeKDFInCounterMode(hashedInputData, KEY_DERIVATION_LABELS.SIGNING));

            const sessionKeyUsages = KEY_USAGES.RT_BINDING.DERIVATION_KEY as KeyUsage[];
            const sessionKeyAlgorithm: HmacImportParams = { name: "HMAC", hash: "SHA-256" };
            const sessionKey = await window.crypto.subtle.importKey("raw", derivedKeyData, sessionKeyAlgorithm, false, sessionKeyUsages);
            console.log("SK: ", sessionKey);
            // Next two lines work
            const encodedCtx = this.b64Encode.encode(BrowserStringUtils.utf8ArrToString(ctx));
            const header = {
                ctx: encodedCtx,
                alg: "HS256"
            };

            const encodedHeader = this.b64Encode.urlEncode(JSON.stringify(header));
            const encodedPayload = this.b64Encode.encode(JSON.stringify(payload));

            const jwtString = `${encodedHeader}.${encodedPayload}`;

            // Sign token
            const tokenBuffer = BrowserStringUtils.stringToArrayBuffer(jwtString);
            const cryptoKeyOptions = this._rtBindingKeyOptions;
            cryptoKeyOptions.keyGenAlgorithmOptions.name = "HMAC";
            const signatureBuffer = await this.browserCrypto.sign(
                cryptoKeyOptions,
                sessionKey,
                tokenBuffer
            );
            const encodedSignature = this.b64Encode.urlEncodeArr(new Uint8Array(signatureBuffer));
            return `${jwtString}.${encodedSignature}`;
        }
        return payload;
    }
}
