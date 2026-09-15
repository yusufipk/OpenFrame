# Project folders and content access

Projects may contain videos at their root and folders nested up to ten levels. Names are free-form; years, languages, durations and aspect ratios are not schema fields. Each delivery remains a Video, with revisions stored as VideoVersion. Workspace folders are a separate future organizational feature and are not part of this change.

## Access

New folders and videos use INHERIT. A root item inherits project permissions; nested items inherit their parent. RESTRICTED stops permissions inherited by ordinary members, including PUBLIC visitors and workspace commentators. Direct grants apply at their assigned folder or video and flow through inherited descendants. A deeper restriction stops those grants. Lists are resolved dynamically, not copied into descendants.

Existing project owners, project administrators, workspace owners and workspace administrators retain management access. Scoped ADMIN invitations grant management of the assigned area; scoped COMMENTATOR invitations grant viewing and commenting, including the existing comment attachment capabilities, but not video creation or management. A scoped grant does not create project or workspace membership. All grants remain subject to the workspace owner's billing access. Storage, reservations and usage continue to be billed to that owner.

Folders and videos appear together in the project content grid. Add Folder opens a dialog beside Add Video; folder management stays under Folder options. Shared with me in the main navigation lists directly assigned folders and videos. Folder breadcrumbs begin at an accessible ancestor; hidden parents and siblings are not listed. All accessible videos means accessible videos within the current project, including other directly assigned areas. Selection and pagination reset when switching folders or views. Downloads use explicitly selected accessible video IDs. A refused mixed batch changes no videos.

Folder cards use a compact layout and provide their own Share action. Inside a folder, the header Share action opens that folder’s account invitations and access controls. At the project root, the header Share action still manages project links. The dialog names the folder being shared.

Account invitations expire after seven days and are accepted only by the invited email account. The content access dialog creates an invitation URL for the administrator to send. It does not automatically send email. Administrators can remove members and cancel pending invitations there. Member removal cuts off account access immediately on the next request; a separately issued valid video link remains an independent grant until revoked. Authorization-sensitive responses do not use stale browser caches.

## Guest links

Existing video links are independent grants to one video and its versions, comments and supported attachments. They never grant access to sibling videos, folder listings or approval rosters. Password, expiry, billing and revocation checks remain in force. Project-wide guest access does not cross a restricted boundary.

Changing a folder or video's access mode revokes video links in the affected area after explicit confirmation. Folder moves and video moves also revoke affected video links after confirmation. This conservative policy includes moves that narrow access. A manager can subsequently create a fresh video link, including for restricted content; the sharing screen explains that it grants separate access. Migration itself does not revoke existing links.

## Moves and consistency

Folder create, rename, move and empty-folder delete operate within a project. Nonempty folders cannot be deleted. Composite foreign keys require a folder's parent and a video's folder to belong to the same project. A database trigger rejects cycles and trees deeper than ten levels, including moved descendants. Mutations use serializable transactions and acquire project locks in stable order; a concurrent conflicting change may return a conflict that requires refreshing.

A change preview is bound to its actor, exact operation and current permission graph, including memberships and share links. A stale or mismatched confirmation produces a new preview without applying the mutation. Inherited content takes destination permissions. Restricted content retains its own direct grants. Cross-project moves remain within one workspace, clear or replace folderId, preserve video IDs, versions and direct video invitations, revoke video links, and make the destination project's managers authoritative. Source-folder grants no longer apply after the move. Files are not physically relocated. Bulk deletion keeps the existing storage-first retry behavior, with a 60-second storage deadline and a 120-second transaction budget. Storage and database deletion are not atomic: a failed batch may have removed some media while retaining video rows for a retry.

Upload admission captures the folder, or target video for a revision. R2 sessions retain that target even after folder deletion, and Bunny grants sign it. Finalization validates the saved target and current permission again. Deleted destinations and revoked access fail; uploads never silently fall back to project root. Failed uploads can leave temporary objects and quota reservations until cancellation or existing expiry cleanup. Media URLs already issued by an external provider cannot be recalled by an account-permission change; provider playback and storage URL lifetime still apply.

## Migration and deployment

The additive migration `20260915120000_project_folders` adds separate project folder and content membership tables, two invitation scopes, nullable upload destinations, and nullable Video.folderId with INHERIT defaults. Existing videos stay at root, existing links stay valid, and VideoVersion relationships and media objects remain unchanged. Apply the migration before deploying code that reads these fields. Production deployment and live database migration are separate operator actions.

No folder guest-link system, drag-and-drop folder movement, archive operation, folder quota, version-level permission, or workspace folder model is included. Existing file-drop uploading remains available. API integration tests use real PostgreSQL with mocked storage providers; they do not establish behavior of a deployed Bunny or S3 service.
