import { APIError, type CollectionConfig, type PayloadRequest } from 'payload'

import { dissolveIfAlone, revokeSessions } from './sessions.js'
import { hatsStateOf, idOf } from './state.js'
import { LINKS, MEMBERS, SESSIONS, type HatsUser, type ResolvedHatsOptions } from './types.js'

const internal = (req: PayloadRequest) => req.context?.hatsInternal === true

/**
 * Whether the request's user may approve links. A person never approves their own link: an approver who is (or
 * who signed in as) a member of the set is refused, so the owner's own links need another approver.
 */
async function approver(opts: ResolvedHatsOptions, req: PayloadRequest) {
  const user = req.user as HatsUser | null
  if (!user || user.collection !== opts.users || !opts.canApproveLinks) return false
  return Boolean(await opts.canApproveLinks({ req, user }))
}

export function hatCollections(opts: ResolvedHatsOptions): CollectionConfig[] {
  const canApprove = ({ req }: { req: PayloadRequest }) => approver(opts, req)
  const never = () => false

  const links: CollectionConfig = {
    slug: LINKS,
    labels: { singular: 'Linked set', plural: 'Linked sets' },
    admin: { hidden: true, group: 'Accounts', useAsTitle: 'label' },
    access: { read: canApprove, create: never, update: never, delete: never },
    fields: [
      // What approvers see where a row names its set: "Started by someone@example.com".
      { name: 'label', type: 'text', admin: { readOnly: true } },
      { name: 'requestedBy', type: 'relationship', relationTo: opts.users as never, admin: { readOnly: true } },
    ],
  }

  const members: CollectionConfig = {
    slug: MEMBERS,
    labels: { singular: 'Linked account', plural: 'Linked accounts' },
    admin: {
      group: 'Accounts',
      defaultColumns: ['user', 'status', 'link', 'confirmedAt', 'approvedAt'],
      description:
        'Accounts that one person asked to link. Approve a confirmed one by setting its status to Approved. You can’t approve a set you belong to. Delete a row to unlink it.',
    },
    access: { read: canApprove, create: never, update: canApprove, delete: canApprove },
    fields: [
      { name: 'link', type: 'relationship', relationTo: LINKS, required: true, index: true, label: 'Linked set', admin: { readOnly: true, description: 'Filter the list by this set to see every account in it.' } },
      { name: 'user', type: 'relationship', relationTo: opts.users as never, required: true, unique: true, admin: { readOnly: true } },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'requested',
        options: [
          { label: 'Waiting for the email to be confirmed', value: 'requested' },
          { label: 'Confirmed, waiting for approval', value: 'confirmed' },
          { label: 'Approved', value: 'approved' },
        ],
      },
      { name: 'tokenHash', type: 'text', index: true, hidden: true },
      { name: 'tokenExpires', type: 'date', hidden: true },
      { name: 'addedBy', type: 'relationship', relationTo: opts.users as never, admin: { readOnly: true } },
      { name: 'confirmedAt', type: 'date', admin: { readOnly: true } },
      { name: 'approvedBy', type: 'relationship', relationTo: opts.users as never, admin: { readOnly: true } },
      { name: 'approvedAt', type: 'date', admin: { readOnly: true } },
    ],
    hooks: {
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          if (internal(req)) return data
          // Outside the plugin's own endpoints, the only change allowed is an approver approving a confirmed account.
          if (operation !== 'update' || !originalDoc) throw new APIError('Links are requested from the account page.', 403, undefined, true)
          if (!(await approver(opts, req))) throw new APIError('You can’t approve links.', 403, undefined, true)
          const fields = ['link', 'user', 'tokenHash', 'tokenExpires', 'addedBy', 'confirmedAt', 'approvedBy', 'approvedAt'] as const
          for (const f of fields)
            if (f in data && data[f] !== undefined && String(idOf(data[f] ?? null)) !== String(idOf(originalDoc[f] ?? null)))
              throw new APIError('Only the status can be changed here.', 403, undefined, true)
          if (data.status === originalDoc.status) return data
          if (originalDoc.status !== 'confirmed' || data.status !== 'approved')
            throw new APIError('Only a confirmed account can be approved, and an approval can’t be undone here: delete the row to unlink.', 400, undefined, true)
          const me = req.user as HatsUser
          const people = [String(me.id), hatsStateOf(me)?.via].filter(Boolean) as string[]
          const mine = await req.payload.count({
            collection: MEMBERS,
            where: { and: [{ link: { equals: idOf(originalDoc.link) } }, { user: { in: people } }] },
            overrideAccess: true,
            req,
          })
          if (mine.totalDocs > 0) throw new APIError('You can’t approve a set you belong to. Ask another administrator.', 403, undefined, true)
          return { ...data, approvedBy: me.id, approvedAt: new Date().toISOString() }
        },
      ],
      afterChange: [
        async ({ doc, previousDoc, operation, req }) => {
          if (operation === 'update' && previousDoc?.status !== 'approved' && doc.status === 'approved' && !internal(req))
            await opts.onEvent?.({ type: 'link-approved', req, link: idOf(doc.link), account: idOf(doc.user), by: String((req.user as HatsUser).id) })
        },
      ],
      afterDelete: [
        async ({ doc, req }) => {
          const link = idOf(doc.link)
          const account = idOf(doc.user)
          await revokeSessions(req.payload, { and: [{ link: { equals: link } }, { or: [{ user: { equals: account } }, { via: { equals: account } }] }] }, 'unlinked', req)
          if (!internal(req)) await opts.onEvent?.({ type: 'unlinked', payload: req.payload, link, account, by: req.user ? String((req.user as HatsUser).id) : null })
          if (!req.context?.hatsDissolving) await dissolveIfAlone(req.payload, link, req)
        },
      ],
    },
  }

  const sessions: CollectionConfig = {
    slug: SESSIONS,
    admin: { hidden: true },
    access: { read: never, create: never, update: never, delete: never },
    fields: [
      { name: 'sid', type: 'text', required: true, unique: true },
      { name: 'user', type: 'text', required: true, index: true },
      { name: 'via', type: 'text', index: true },
      { name: 'link', type: 'text', index: true },
      { name: 'hat', type: 'text' },
      // Per account: when its second factor was last given in this browser, so switching up is asked again later.
      { name: 'steppedUp', type: 'json' },
      { name: 'expiresAt', type: 'date', index: true },
    ],
  }

  return [links, members, sessions]
}
