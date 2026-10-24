@id:portal-users
Feature: Users in the portal
  The admin manages accounts on the user list. Each account has one role.
  Actions that end sessions or remove data ask first in a dialog. Cancel puts the focus back where it was.
  When core refuses a change, the portal says why.

  Rule: A role change shows on the user list and on the roles page

    Scenario: The admin moves user 12 to "viewers", and the roles page counts it
      Given user 12 has the role "family"
      And the role "viewers"
      When the admin picks the role "viewers" for user 12 on the user list
      Then the roles page shows 1 user in "viewers" and 0 users in "family"

    Scenario: The last admin cannot leave the admin role
      When the admin picks the role "viewers" for themselves on the user list
      Then the portal shows the alert "You cannot remove the last enabled admin"

    Scenario: A user list that cannot load says why
      Given the server cannot read its users
      When the admin opens the user list
      Then the portal shows why the user list did not load

  Rule: An SSO account gets no password on the user list

    Scenario: The user list offers no password for user 12
      Given the admin set up single sign-on with "Acme ID"
      And user 12 has an SSO account with the role "family"
      When the admin opens the user list
      Then the row of user 12 shows "SSO" and offers no "Set password"

  Rule: Row actions ask in a dialog, and Cancel puts the focus back

    Scenario: Disabling user 12 asks first and ends their sessions
      Given user 12 has the role "family"
      When the admin disables user 12 on the user list and confirms the question
      Then the question said "Their sessions end now."
      And user 12 shows as disabled

    Scenario: A cancelled two-factor reset changes nothing and puts the focus back
      Given user 12 has the role "family" and an authenticator app
      When the admin starts to reset two-factor for user 12 and cancels the question
      Then the focus is back on the two-factor reset of user 12
      And user 12 still has two-factor sign-in

    Scenario: A new password needs 12 characters, and user 12 then signs in with it
      Given user 12 has the role "family"
      When the admin sets the password "family passphrase 2" for user 12 on the user list
      Then the dialog took no password shorter than 12 characters
      And user 12 can sign in with "family passphrase 2"

  Rule: Adding and deleting users go through dialogs that core checks

    Scenario: A taken name shows in the add dialog, and the next dialog starts empty
      Given user 12 has the role "family"
      When the admin adds a user with the name of user 12
      Then the add dialog shows the alert "That username is taken"
      And the next add dialog starts empty

    Scenario: A delete needs the exact name
      Given user 12 has the role "family"
      When the admin deletes user 12 on the user list, typing their name in the question
      Then the delete was unavailable until the name was exact
      And user 12 is gone from the user list

    Scenario: The admin cannot delete or disable their own account
      When the admin opens the user list
      Then the row of the admin offers no delete and no disable
