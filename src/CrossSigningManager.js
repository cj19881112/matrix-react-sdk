/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import Modal from './Modal';
import sdk from './index';
import MatrixClientPeg from './MatrixClientPeg';
import { deriveKey } from 'matrix-js-sdk/lib/crypto/key_passphrase';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto/recoverykey';
import { _t } from './languageHandler';

// This stores the secret storage private keys in memory for the JS SDK. This is
// only meant to act as a cache to avoid prompting the user multiple times
// during the same single operation. Use `accessSecretStorage` below to scope a
// single secret storage operation, as it will clear the cached keys once the
// operation ends.
let secretStorageKeys = {};
let cachingAllowed = false;

async function getSecretStorageKey({ keys: keyInfos }) {
    const keyInfoEntries = Object.entries(keyInfos);
    if (keyInfoEntries.length > 1) {
        throw new Error("Multiple storage key requests not implemented");
    }
    const [name, info] = keyInfoEntries[0];

    // Check the in-memory cache
    if (cachingAllowed && secretStorageKeys[name]) {
        return [name, secretStorageKeys[name]];
    }

    const inputToKey = async ({ passphrase, recoveryKey }) => {
        if (passphrase) {
            return deriveKey(
                passphrase,
                info.passphrase.salt,
                info.passphrase.iterations,
            );
        } else {
            return decodeRecoveryKey(recoveryKey);
        }
    };
    const AccessSecretStorageDialog =
        sdk.getComponent("dialogs.secretstorage.AccessSecretStorageDialog");
    const { finished } = Modal.createTrackedDialog("Access Secret Storage dialog", "",
        AccessSecretStorageDialog,
        {
            keyInfo: info,
            checkPrivateKey: async (input) => {
                const key = await inputToKey(input);
                return MatrixClientPeg.get().checkSecretStoragePrivateKey(key, info.pubkey);
            },
        },
    );
    const [input] = await finished;
    if (!input) {
        throw new Error("Secret storage access canceled");
    }
    const key = await inputToKey(input);

    // Save to cache to avoid future prompts in the current session
    if (cachingAllowed) {
        secretStorageKeys[name] = key;
    }

    return [name, key];
}

export const crossSigningCallbacks = {
    getSecretStorageKey,
};

/**
 * This helper should be used whenever you need to access secret storage. It
 * ensures that secret storage (and also cross-signing since they each depend on
 * each other in a cycle of sorts) have been bootstrapped before running the
 * provided function.
 *
 * Bootstrapping secret storage may take one of these paths:
 * 1. Create secret storage from a passphrase and store cross-signing keys
 *    in secret storage.
 * 2. Access existing secret storage by requesting passphrase and accessing
 *    cross-signing keys as needed.
 * 3. All keys are loaded and there's nothing to do.
 *
 * Additionally, the secret storage keys are cached during the scope of this function
 * to ensure the user is prompted only once for their secret storage
 * passphrase. The cache is then
 *
 * @param {Function} [func] An operation to perform once secret storage has been
 * bootstrapped. Optional.
 */
export async function accessSecretStorage(func = async () => { }) {
    const cli = MatrixClientPeg.get();
    cachingAllowed = true;

    try {
        if (!cli.hasSecretStorageKey()) {
            // This dialog calls bootstrap itself after guiding the user through
            // passphrase creation.
            const { finished } = Modal.createTrackedDialogAsync('Create Secret Storage dialog', '',
                import("./async-components/views/dialogs/secretstorage/CreateSecretStorageDialog"),
                null, null, /* priority = */ false, /* static = */ true,
            );
            const [confirmed] = await finished;
            if (!confirmed) {
                throw new Error("Secret storage creation canceled");
            }
        } else {
            const InteractiveAuthDialog = sdk.getComponent("dialogs.InteractiveAuthDialog");
            await cli.bootstrapSecretStorage({
                authUploadDeviceSigningKeys: async (makeRequest) => {
                    const { finished } = Modal.createTrackedDialog(
                        'Cross-signing keys dialog', '', InteractiveAuthDialog,
                        {
                            title: _t("Send cross-signing keys to homeserver"),
                            matrixClient: MatrixClientPeg.get(),
                            makeRequest,
                        },
                    );
                    const [confirmed] = await finished;
                    if (!confirmed) {
                        throw new Error("Cross-signing key upload auth canceled");
                    }
                },
            });
        }

        // `return await` needed here to ensure `finally` block runs after the
        // inner operation completes.
        return await func();
    } finally {
        // Clear secret storage key cache now that work is complete
        cachingAllowed = false;
        secretStorageKeys = {};
    }
}
