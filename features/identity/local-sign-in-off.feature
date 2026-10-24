@id:local-sign-in-off
Feature: Password sign-in off
  The admin can turn off sign-in with a password, so that people sign in only with single sign-on.
  Core keeps at least one way in. The operator can force password sign-in back on at start-up.

  Background:
    Given user 12 has an SSO account with the role "family"

  Rule: Password sign-in turns off only while single sign-on works

    Scenario: Password sign-in stays on without single sign-on
      When the admin turns off password sign-in
      Then the admin is told "Enable OIDC and add at least one SSO account before disabling local login"

    Scenario: With an SSO account, password sign-in turns off
      Given the admin set up single sign-on with Acme ID
      When the admin turns off password sign-in
      Then a sign-in with a password is told "Use single sign-on" in the portal and on the consent page, which offers only Acme ID

  Rule: While password sign-in is off, single sign-on stays usable

    Scenario: Nothing may remove the last way in
      Given the admin set up single sign-on with Acme ID
      And password sign-in is off
      When the admin tries each change that would leave no SSO account that signs in
      Then each change is refused, because password sign-in is off

    Scenario: With password sign-in on again, the admin can disable user 12
      Given the admin set up single sign-on with Acme ID
      And password sign-in was off, and the admin turned it on again
      When the admin disables user 12
      Then the admin sees that user 12 is disabled

  Rule: The operator can force password sign-in back on

    Scenario: A restart with password sign-in forced on lets the admin in
      Given the admin set up single sign-on with Acme ID
      And password sign-in is off
      When the operator restarts the server with password sign-in forced on
      Then the admin can sign in to the portal with a password
