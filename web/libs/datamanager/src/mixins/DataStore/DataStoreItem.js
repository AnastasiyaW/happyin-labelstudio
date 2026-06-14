import { applySnapshot, getParent, getSnapshot, isAlive, types } from "mobx-state-tree";
import { guidGenerator } from "../../utils/random";
import { FF_LOPS_E_3, isFF } from "../../utils/feature-flags";

export const DataStoreItem = types
  .model("DataStoreItem", {
    updated: guidGenerator(),
    loading: isFF(FF_LOPS_E_3) ? types.maybeNull(types.union(types.string, types.boolean), false) : false,
  })
  .views((self) => ({
    // cars-mods: dead-node guard. During a list reload the item node is detached; getParent() on a
    // detached MST node THROWS ("Failed to find the parent … [dead]"). isSelected/isHighlighted read
    // through `parent`, and list-view rows (TableRow) read isSelected during the reload churn → flood
    // + broken view. isAlive() is safe on a dead node; return null/false so reads never throw.
    get parent() {
      if (!isAlive(self)) return null;
      return getParent(getParent(self));
    },

    get isSelected() {
      return isAlive(self) && self.parent?.selected === self;
    },

    get isHighlighted() {
      return isAlive(self) && self.parent?.highlighted === self;
    },

    get isLoading() {
      return isAlive(self) ? !!self.parent?.itemIsLoading(self.id) : false;
    },
  }))
  .actions((self) => ({
    update(newData) {
      const patch = {
        ...getSnapshot(self),
        ...newData,
        updated: guidGenerator(),
      };

      try {
        applySnapshot(self, patch);
      } catch (err) {
        console.log(err);
      }
      return self;
    },

    setLoading(loading) {
      self.loading = loading;
    },

    markUpdated() {
      self.updated = guidGenerator();
    },
  }));
