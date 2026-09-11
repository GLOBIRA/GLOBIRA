
nothing added to commit but untracked files present (use "git add" to track)
To https://github.com/GLOBIRA/GLOBIRA.git
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'https://github.com/GLOBIRA/GLOBIRA.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
PS C:\Users\HP\Desktop\GLOBIRA\GLOBIRA-GIT> git pull --rebase origin main
remote: Enumerating objects: 11, done.
remote: Counting objects: 100% (11/11), done.
remote: Compressing objects: 100% (8/8), done.
remote: Total 8 (delta 4), reused 0 (delta 0), pack-reused 0 (from 0)
Unpacking objects: 100% (8/8), 6.98 KiB | 137.00 KiB/s, done.
From https://github.com/GLOBIRA/GLOBIRA
 * branch            main       -> FETCH_HEAD
   c186587..8e14841  main       -> origin/main
Updating c186587..8e14841
Fast-forward
 index.html | 187 +++++++++++----------
 server.js  | 548 ++++++++++++++++++++++++++++++++-----------------------------
 2 files changed, 383 insertions(+), 352 deletions(-)
PS C:\Users\HP\Desktop\GLOBIRA\GLOBIRA-GIT> git push origin main
Everything up-to-date
PS C:\Users\HP\Desktop\GLOBIRA\GLOBIRA-GIT> 
