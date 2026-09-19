/* Three-way record merging. A stale device never silently overwrites an edit. */
const SyncCore = (() => {
    const stores = ['sources', 'highlights', 'readingNotes'];
    const empty = () => Object.fromEntries(stores.map(name => [name, []]));
    const canonical = value => JSON.stringify(value, function (key, entry) {
        if (key === 'cloudAttachment') return undefined;
        return entry && typeof entry === 'object' && !Array.isArray(entry)
            ? Object.fromEntries(Object.keys(entry).sort().map(k => [k, entry[k]])) : entry;
    });
    const equal = (a, b) => canonical(a) === canonical(b);
    const key = (store, id) => `${store}/${id}`;
    function merge(base, local, remote, resolutions = {}) {
        const result = empty();
        const conflicts = [];
        for (const store of stores) {
            const maps = [base, local, remote].map(data => new Map((data[store] || []).map(row => [row.id, row])));
            const ids = new Set(maps.flatMap(map => [...map.keys()]));
            for (const id of ids) {
                const [before, here, there] = maps.map(map => map.get(id));
                let chosen;
                if (equal(here, there) || equal(before, there)) chosen = here;
                else if (equal(before, here)) chosen = there;
                else {
                    const resolution = resolutions[key(store, id)];
                    // Resolutions apply only to the exact pair the user reviewed.
                    if (resolution && equal(resolution.local, here) && equal(resolution.remote, there)) {
                        chosen = resolution.choice === 'local' ? here : there;
                    } else {
                        conflicts.push({ store, id, local: here, remote: there });
                        chosen = here;
                    }
                }
                if (chosen !== undefined) result[store].push(chosen);
            }
        }
        // Deleting a source on one device while another changes a linked note
        // must not leave an invisible orphan. Let the user restore the source
        // or accept deletion of its remaining linked records.
        const sourceIds = new Set(result.sources.map(row => row.id));
        const handled = new Set();
        for (const store of ['highlights', 'readingNotes']) {
            for (const row of [...result[store]]) {
                if (!row.sourceId || sourceIds.has(row.sourceId) || handled.has(row.sourceId)) continue;
                handled.add(row.sourceId);
                const source = local.sources.find(item => item.id === row.sourceId) || base.sources.find(item => item.id === row.sourceId);
                if (!source) continue; // Legacy standalone/orphan records remain recoverable.
                const conflict = { store: 'sources', id: source.id, local: source, remote: undefined,
                    reason: 'This source was deleted while linked items or notes changed. Keeping the cloud deletion also removes the remaining linked items and notes.' };
                const resolution = resolutions[key('sources', source.id)];
                if (resolution && equal(resolution.local, source) && resolution.remote === undefined) {
                    if (resolution.choice === 'local') { result.sources.push(source); sourceIds.add(source.id); }
                    else {
                        result.highlights = result.highlights.filter(item => item.sourceId !== source.id);
                        result.readingNotes = result.readingNotes.filter(item => item.sourceId !== source.id);
                    }
                } else if (!conflicts.some(item => item.store === 'sources' && item.id === source.id)) conflicts.push(conflict);
            }
        }
        return { data: result, conflicts };
    }
    function changes(from, to) {
        const result = [];
        for (const store of stores) {
            const previous = new Map(from[store].map(row => [row.id, row]));
            const next = new Map(to[store].map(row => [row.id, row]));
            for (const id of new Set([...previous.keys(), ...next.keys()])) {
                if (!equal(previous.get(id), next.get(id))) result.push({ store, id, value: next.get(id) });
            }
        }
        return result.sort((a, b) => Number(a.store === 'sources' && a.value === undefined) - Number(b.store === 'sources' && b.value === undefined));
    }
    function apply(data, edits) {
        const result = {};
        for (const store of stores) {
            const map = new Map(data[store].map(row => [row.id, row]));
            for (const edit of edits.filter(item => item.store === store)) {
                if (edit.value === undefined) map.delete(edit.id);
                else map.set(edit.id, edit.value);
            }
            result[store] = [...map.values()];
        }
        return result;
    }
    return { stores, empty, equal, merge, changes, apply, key };
})();
if (typeof module !== 'undefined') module.exports = SyncCore;
