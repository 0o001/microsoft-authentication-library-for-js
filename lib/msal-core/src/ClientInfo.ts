﻿/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { CryptoUtils } from "./utils/CryptoUtils";
import { ClientAuthError } from "./error/ClientAuthError";
import { StringUtils } from "./utils/StringUtils";

/**
 * @hidden
 */
export class ClientInfo {

    private _uid: string;
    get uid(): string {
        return this._uid ? this._uid : "";
    }

    set uid(uid: string) {
        this._uid = uid;
    }

    private _utid: string;
    get utid(): string {
        return this._utid ? this._utid : "";
    }

    set utid(utid: string) {
        this._utid = utid;
    }

    constructor(rawClientInfo: string, authority: string) {
        if (!rawClientInfo || StringUtils.isEmpty(rawClientInfo)) {
            this.uid = "";
            this.utid = "";
            return;
        }

        try {
            const decodedClientInfo: string = CryptoUtils.base64Decode(rawClientInfo);
            const clientInfo: ClientInfo = <ClientInfo>JSON.parse(decodedClientInfo);
            if (clientInfo) {
                if (clientInfo.hasOwnProperty("uid")) {
                    this.uid = ClientInfo.stripPolicyFromUid(clientInfo.uid, authority);
                }

                if (clientInfo.hasOwnProperty("utid")) {
                    this.utid = clientInfo.utid;
                }
            }
        } catch (e) {
            throw ClientAuthError.createClientInfoDecodingError(e);
        }
    }

    static stripPolicyFromUid(uid: string, authority: string): string {
        console.log("Strip Policy")
        const uidSegments = uid.split("-");
        const urlSegments = authority.split("/").reverse();
        let policy = ""

        if (!StringUtils.isEmpty(urlSegments[0])) {
            policy = urlSegments[0];
        } else if (urlSegments.length > 1) {
            policy = urlSegments[1];
        }

        if (uidSegments[uidSegments.length - 1] ===  policy) {
            return uidSegments.slice(0, uidSegments.length - 1).join("-");
        }

        return uid;
    }

    public encodeClientInfo() {
        const clientInfo = JSON.stringify({uid: this.uid, utid: this.utid});

        return CryptoUtils.base64Encode(clientInfo);
    }
}
