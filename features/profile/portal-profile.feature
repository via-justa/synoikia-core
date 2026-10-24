@id:portal-profile
Feature: My profile in the portal
  Each person keeps their own tokens, look of the portal and, for a local account, sign-in methods on My profile.
  A revoke asks first. New recovery codes stay on screen until the person saved them.
  The portal checks that a new password matches before it sends it.

  Rule: An SSO account has no password in the portal

    Scenario: User 12 sees no password on their profile
      Given the admin set up single sign-on with "Acme ID"
      And user 12 has an SSO account with the role "family"
      When user 12 opens their profile
      Then the profile shows no password and no two-factor setup, and says that user 12 signs in with "Acme ID"

  Rule: Own tokens revoke after a question

    Scenario: The admin revokes their own token "laptop"
      Given the admin made their own token "laptop"
      When the admin revokes "laptop" on their profile and confirms the question
      Then the question said "Revoke laptop?"
      And the profile no longer lists "laptop"

  Rule: Recovery codes stay until the person saved them

    Scenario: The admin sets up two-factor and sees the recovery codes until they saved them
      When the admin sets up two-factor sign-in on their profile with the current code
      Then the profile shows the recovery codes until the admin says they saved them
      And the profile says "Enter a current code (or a recovery code) to turn it off."

    Scenario: The recovery codes stay while the portal loads the profile again
      Given the admin set up two-factor sign-in on their profile and sees the recovery codes
      When the browser is offline for a minute and comes back
      Then the profile still shows the recovery codes

  Rule: A current code gives new recovery codes, which stay until the person saved them

    Scenario: The admin gets new recovery codes from their profile
      Given the admin has an authenticator app
      When the admin asks for new recovery codes on their profile with the current code
      Then the profile shows the new recovery codes until the admin says they saved them
      And the profile says "10 recovery codes left"

    Scenario: A wrong code is refused in the question
      Given the admin has an authenticator app
      When the admin asks for new recovery codes on their profile with a wrong code
      Then the question says "Invalid code"

  Rule: A new password is checked before and after it is sent

    Scenario: A new password that does not match its confirmation is not sent
      When the admin changes their password with a confirmation that does not match
      Then the profile says "The new passwords do not match."
      And the admin still signs in with their old password

    Scenario: A wrong current password is refused by core
      When the admin changes their password, giving "not my passphrase" as the current one
      Then the profile says "Current password is incorrect"

  Rule: The theme is kept in the browser

    Scenario: The dark theme stays after a reload
      When the admin picks the theme "Dark" on their profile and reloads the portal
      Then the portal is dark, with "Dark" picked
