import { ContactUpdateError } from '../../../helpers/errors';

/* @ngInject */
function contactEditor(
    $state,
    eventManager,
    Contact,
    contactModal,
    contactEmails,
    contactCache,
    contactLoaderModal,
    contactSchema,
    confirmModal,
    dispatchers,
    gettextCatalog,
    networkActivityTracker,
    notification,
    contactImportEncryption
) {
    const { dispatcher, on } = dispatchers(['contacts', 'progressBar']);

    const I18N = {
        GENERAL_CONTACT_ERROR: gettextCatalog.getString('Error creating a contact', null, 'error message')
    };
    /**
     * Add contacts
     * @param {Array} contacts
     * @param {String} [mode] - pass in 'import' to trigger the contactLoaderModal and show creation progress
     * @return {Promise}
     */
    function create({ contacts = [], mode }) {
        const preCreation = mode === 'import' ? contactImportEncryption.process(contacts) : Promise.resolve(contacts);
        const promise = preCreation.then(Contact.add).then((data) => {
            const { created, errors, total } = data;
            return eventManager.call().then(() => {
                dispatcher.contacts('contactCreated', { created, total, errors, mode });
                return data;
            });
        });

        if (mode === 'import') {
            contactLoaderModal.activate({
                params: {
                    mode: 'import',
                    close() {
                        contactLoaderModal.deactivate();
                    }
                }
            });
        } else {
            networkActivityTracker.track(promise);
        }

        return promise;
    }

    /**
     * Add a single contact using create, but transforming the result of create into a proper error
     * if create encounters an error. The purpose is to make create easier to use for creating a single contact.
     * @param {Object} contact the contact to be created
     * @return {Promise}
     * @throws Error if creation caused an error
     */
    async function createSingular({ contact }) {
        const {
            created: [creationResult],
            errors: [errorResult] = []
        } = await create({ contacts: [contact] });
        if (errorResult || !creationResult) {
            const { code, error = I18N.GENERAL_CONTACT_ERROR } = errorResult || {};
            const exception = new Error(error);
            if (code) {
                exception.Code = code;
            }
            throw exception;
        }
        return creationResult;
    }

    /**
     * Summarize the results of each merge operation.
     * @param results
     * @returns {{updated: Array, removed: Array, errors: Array}}
     */
    function summarizeMergeResults(results = []) {
        return results.reduce(
            (agg, result) => {
                if (result.updated) {
                    agg.updated.push(result.updated);
                }
                if (result.removed) {
                    agg.removed = agg.removed.concat(result.removed);
                }
                if (result.errors) {
                    agg.errors = agg.errors.concat(result.errors);
                }
                if (result.total) {
                    agg.total += result.total;
                }
                return agg;
            },
            { updated: [], removed: [], errors: [], total: 0 }
        );
    }

    /**
     * Update and remove contacts.
     * @param {object} update Contact to update
     * @param {Array} remove IDs to remove
     * @returns {Promise}
     */
    async function updateAndRemove({ update, remove = [] }) {
        // Total is the contact to update + the ones to remove.
        const total = remove.length + (update ? 1 : 0);
        try {
            if (update) {
                // Update the contact.
                await updateContact(update);
            }

            // Remove the other contacts.
            const { removed = [], errors = [] } = await Contact.remove({ IDs: remove });

            return {
                total,
                updated: update,
                removed,
                errors: errors.map(({ Error }) => Error)
            };
        } catch (error) {
            return {
                total,
                updated: error instanceof ContactUpdateError ? undefined : update,
                errors: [error.message]
            };
        }
    }

    /**
     * Announce progressbar for each group of updates.
     * @param {Array} actions
     * @param {Number} total
     */
    function mergeProgressAnnouncer({ actions = [], total = 0 }) {
        let progress = 0;
        actions.forEach((action) => {
            action.then((result) => {
                // When a group has finished, update the progress.
                progress += Math.floor((result.total * 100) / total);
                dispatcher.progressBar('contactsProgressBar', { progress });
                return result;
            });
        });
    }

    /**
     * Merge contacts
     * @param {{ [group]: Array }} contacts
     * @returns {Promise}
     */
    async function merge(contacts) {
        contactLoaderModal.activate({
            params: {
                mode: 'merge',
                close() {
                    contactLoaderModal.deactivate();
                }
            }
        });

        const groups = Object.keys(contacts);
        // Update and/or remove for each group of contacts.
        const actions = groups.map((group) => updateAndRemove(contacts[group]));
        // Total is contact to update (if any) + contacts to remove
        const total = groups.reduce((sum, group) => {
            const { update, remove = [] } = contacts[group];
            return sum + remove.length + (update ? 1 : 0);
        }, 0);

        // Announce the progress of each group for the contact loader modal.
        mergeProgressAnnouncer({ actions, total });

        // Once all the actions have completed, announce the finalisation for the concat loader modal with the summarized results.
        const promise = Promise.all(actions)
            .then(summarizeMergeResults)
            .then((summarizedResults) => {
                // To notify that some contacts have been deleted.
                dispatcher.contacts('contactsUpdated');

                // To finish the loading modal.
                dispatcher.contacts('contactsMerged', summarizedResults);

                // Remove any selected contacts.
                dispatcher.contacts('selectContacts', { isChecked: false });

                // To update for the deleted contacts.
                return eventManager.call();
            });

        networkActivityTracker.track(promise);

        return promise;
    }

    /**
     * Update a contact and emit the 'contactUpdated' event.
     * @param {Object} contact
     * @returns {Promise}
     */
    function updateContact(contact) {
        return Contact.update(contact).then((result) => {
            const { Contact, cards } = result;
            dispatcher.contacts('contactUpdated', { contact: Contact, cards });
            return result;
        });
    }

    /**
     * Update a contact, show the success dialog and call the event manager.
     * @param {Object} contact
     * @return {Promise}
     */
    function update({ contact = {} }) {
        const promise = updateContact(contact).then(() => {
            notification.success(gettextCatalog.getString('Contact edited', null, 'Success message'));
            return eventManager.call();
        });

        networkActivityTracker.track(promise);
        return promise;
    }

    /**
     * Edit the unencrypted part of a contact
     * @param {Object} contact
     * @return {Promise}
     */
    function updateUnencrypted({ contact = {} }) {
        const promise = Contact.updateUnencrypted(contact).then(({ Contact, cards }) => {
            dispatcher.contacts('contactUpdated', { contact: Contact, cards });
            notification.success(gettextCatalog.getString('Contact edited', null, 'Success message'));
            return eventManager.call();
        });

        networkActivityTracker.track(promise);
        return promise;
    }

    /**
     * Delete contact(s)
     * @param {Array} contactIDs The contactIDs to delete
     * @param {boolean} confirm whether to ask for confirmation before deleting
     */
    function remove({ contactIDs = [], confirm = true }) {
        const success =
            contactIDs === 'all'
                ? gettextCatalog.getString('All contacts deleted', null, 'Success')
                : gettextCatalog.getPlural(contactIDs.length, 'Contact deleted', 'Contacts deleted', null, 'Success');

        const process = () => {
            return requestDeletion(contactIDs).then(() => {
                notification.success(success);
                $state.go('secured.contacts');

                // Remove all selected contacts after deleting a contact.
                dispatcher.contacts('selectContacts', { isChecked: false });
            });
        };

        if (confirm) {
            return confirmDeletion(contactIDs, () => process());
        }

        return process();
    }

    function requestDeletion(IDs = []) {
        const promise = IDs === 'all' ? Contact.clear() : Contact.remove({ IDs });

        networkActivityTracker.track(promise);

        return promise.then(() => {
            if (IDs === 'all') {
                contactCache.clear();
                contactEmails.clear();
            }

            return eventManager.call();
        });
    }

    function confirmDeletion(contactIDs = [], callback) {
        const message =
            contactIDs === 'all'
                ? gettextCatalog.getString('Are you sure you want to delete all your contacts?', null, 'Info')
                : gettextCatalog.getPlural(
                      contactIDs.length,
                      'Are you sure you want to delete this contact?',
                      'Are you sure you want to delete the selected contacts?',
                      null,
                      'Info'
                  );
        const title =
            contactIDs === 'all'
                ? gettextCatalog.getString('Delete all', null, 'Title')
                : gettextCatalog.getString('Delete', null, 'Title');

        confirmModal.activate({
            params: {
                title,
                message,
                confirm() {
                    callback();
                    confirmModal.deactivate();
                },
                cancel() {
                    confirmModal.deactivate();
                }
            }
        });
    }

    function add({ email, name }) {
        const contact = angular.copy(contactSchema.contactAPI);

        email && contact.vCard.add('email', email);
        name && contact.vCard.add('fn', name);

        contactModal.activate({
            params: {
                contact,
                close() {
                    contactModal.deactivate();
                }
            }
        });
    }

    on('contacts', (event, { type, data = {} }) => {
        type === 'deleteContacts' && remove(data);
        type === 'updateContact' && update(data);
        type === 'createContact' && create(data);
        type === 'addContact' && add(data);
    });

    return { init: angular.noop, create, createSingular, update, updateUnencrypted, remove, merge };
}

export default contactEditor;
