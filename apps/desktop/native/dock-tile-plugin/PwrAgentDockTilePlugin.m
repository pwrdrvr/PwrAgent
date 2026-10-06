#import <AppKit/AppKit.h>

@interface PwrAgentDockTilePlugin_com_pwrdrvr_pwragent : NSObject <NSDockTilePlugIn>

@property(nonatomic, strong) NSMenu *retainedDockMenu;

@end

@implementation PwrAgentDockTilePlugin_com_pwrdrvr_pwragent

- (void)setDockTile:(NSDockTile *)dockTile {
  // The profile launcher only customizes the menu. Keeping this method empty
  // also avoids asking Dock to repaint the application icon.
}

- (NSMenu *)dockMenu {
  NSDictionary *snapshot = [self loadProfileSnapshot];
  NSString *pwragentHome = [self pwragentHomeFromSnapshot:snapshot];
  NSArray<NSDictionary *> *profiles = pwragentHome == nil
    ? @[]
    : [self orderedProfilesFromSnapshot:snapshot];
  NSArray<NSDictionary *> *shownProfiles = [profiles
    filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(
      NSDictionary *profile,
      NSDictionary *bindings
    ) {
      return ![profile[@"showInMenu"] isEqual:@NO];
    }]];

  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  menu.autoenablesItems = NO;

  // Every profile switched out of the Profiles menu is a choice, not an
  // empty state, so the Dock offers no Open Profile item at all, as the
  // running app's Dock menu does.
  if (profiles.count > 0 && shownProfiles.count == 0) {
    self.retainedDockMenu = menu;
    return menu;
  }

  NSMenuItem *openProfileItem = [[NSMenuItem alloc]
    initWithTitle:@"Open Profile"
    action:nil
    keyEquivalent:@""];
  NSMenu *profileMenu = [[NSMenu alloc] initWithTitle:@"Open Profile"];
  profileMenu.autoenablesItems = NO;

  if (profiles.count == 0) {
    NSMenuItem *emptyItem = [[NSMenuItem alloc]
      initWithTitle:@"Open PwrAgent to Load Profiles"
      action:nil
      keyEquivalent:@""];
    emptyItem.enabled = NO;
    [profileMenu addItem:emptyItem];
  } else {
    NSString *defaultProfile = snapshot[@"defaultProfile"];
    for (NSDictionary *profile in shownProfiles) {
      NSString *name = profile[@"name"];
      NSString *displayName = profile[@"displayName"];
      NSString *label = displayName.length > 0 ? displayName : name;
      NSMenuItem *item = [[NSMenuItem alloc]
        initWithTitle:label
        action:@selector(openProfile:)
        keyEquivalent:@""];
      item.target = self;
      item.representedObject = @{
        @"profile": name,
        @"pwragentHome": pwragentHome,
      };
      item.enabled = YES;
      if ([name isEqualToString:defaultProfile]) {
        item.state = NSControlStateValueOn;
      }
      [profileMenu addItem:item];
    }
  }

  openProfileItem.submenu = profileMenu;
  [menu addItem:openProfileItem];

  // NSDockTilePlugIn menus must remain alive until Dock is finished handling
  // the click. A strong property is intentional; returning an autoreleased
  // menu can make its items silently ignore selection.
  self.retainedDockMenu = menu;
  return menu;
}

- (void)openProfile:(NSMenuItem *)sender {
  NSDictionary *launch = sender.representedObject;
  if (![launch isKindOfClass:[NSDictionary class]]) {
    return;
  }
  NSString *profile = launch[@"profile"];
  NSString *pwragentHome = launch[@"pwragentHome"];
  if (![profile isKindOfClass:[NSString class]] || profile.length == 0) {
    return;
  }
  if (![pwragentHome isKindOfClass:[NSString class]]
      || !pwragentHome.isAbsolutePath
      || pwragentHome.length > 4096) {
    return;
  }

  NSURL *applicationURL = [self containingApplicationURL];
  if (applicationURL == nil) {
    return;
  }

  NSWorkspaceOpenConfiguration *configuration =
    [NSWorkspaceOpenConfiguration configuration];
  configuration.arguments = @[@"--profile", profile];
  configuration.environment = @{
    @"PWRAGENT_HOME": [pwragentHome stringByStandardizingPath],
  };
  configuration.activates = YES;
  configuration.createsNewApplicationInstance = YES;

  [[NSWorkspace sharedWorkspace]
    openApplicationAtURL:applicationURL
    configuration:configuration
    completionHandler:^(NSRunningApplication *application, NSError *error) {
      if (error != nil) {
        NSLog(@"PwrAgent Dock profile launch failed: %@", error);
      }
    }];
}

- (NSDictionary *)loadProfileSnapshot {
  NSURL *cachesURL = [[[NSFileManager defaultManager]
    URLsForDirectory:NSCachesDirectory
    inDomains:NSUserDomainMask] firstObject];
  if (cachesURL == nil) {
    return @{};
  }
  NSURL *snapshotURL = [[cachesURL
    URLByAppendingPathComponent:@"com.pwrdrvr.pwragent"
    isDirectory:YES]
    URLByAppendingPathComponent:@"dock-profiles.json"];
  NSData *data = [NSData dataWithContentsOfURL:snapshotURL];
  if (data == nil) {
    return @{};
  }

  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (error != nil || ![value isKindOfClass:[NSDictionary class]]) {
    return @{};
  }
  NSDictionary *snapshot = value;
  if (![snapshot[@"schemaVersion"] isEqual:@2]) {
    return @{};
  }
  return snapshot;
}

- (NSString *)pwragentHomeFromSnapshot:(NSDictionary *)snapshot {
  NSString *pwragentHome = snapshot[@"pwragentHome"];
  if (![pwragentHome isKindOfClass:[NSString class]]
      || !pwragentHome.isAbsolutePath
      || pwragentHome.length == 0
      || pwragentHome.length > 4096) {
    return nil;
  }
  return [pwragentHome stringByStandardizingPath];
}

- (NSArray<NSDictionary *> *)orderedProfilesFromSnapshot:(NSDictionary *)snapshot {
  id rawProfiles = snapshot[@"profiles"];
  if (![rawProfiles isKindOfClass:[NSArray class]]) {
    return @[];
  }

  NSMutableArray<NSDictionary *> *profiles = [NSMutableArray array];
  for (id value in rawProfiles) {
    if (![value isKindOfClass:[NSDictionary class]]) {
      continue;
    }
    NSString *name = value[@"name"];
    if (![name isKindOfClass:[NSString class]]
        || name.length == 0
        || name.length > 128) {
      continue;
    }
    NSString *displayName = value[@"displayName"];
    if (![displayName isKindOfClass:[NSString class]]
        || displayName.length > 256) {
      displayName = nil;
    }
    NSMutableDictionary *profile = [NSMutableDictionary
      dictionaryWithObject:name
      forKey:@"name"];
    if (displayName.length > 0) {
      profile[@"displayName"] = displayName;
    }
    if ([value[@"showInMenu"] isEqual:@NO]) {
      profile[@"showInMenu"] = @NO;
    }
    [profiles addObject:profile];
    if (profiles.count >= 100) {
      break;
    }
  }

  // A snapshot marked `ordered` is already in the Profiles-menu order the
  // operator set in Settings. One without it came from an older PwrAgent,
  // so fall back to the order those builds showed.
  if ([snapshot[@"ordered"] isEqual:@YES]) {
    return profiles;
  }

  NSString *defaultProfile = snapshot[@"defaultProfile"];
  [profiles sortUsingComparator:^NSComparisonResult(
    NSDictionary *left,
    NSDictionary *right
  ) {
    NSString *leftName = left[@"name"];
    NSString *rightName = right[@"name"];
    if ([leftName isEqualToString:defaultProfile]) {
      return [rightName isEqualToString:defaultProfile]
        ? NSOrderedSame
        : NSOrderedAscending;
    }
    if ([rightName isEqualToString:defaultProfile]) {
      return NSOrderedDescending;
    }
    NSString *leftLabel = left[@"displayName"] ?: leftName;
    NSString *rightLabel = right[@"displayName"] ?: rightName;
    return [leftLabel localizedCaseInsensitiveCompare:rightLabel];
  }];
  return profiles;
}

- (NSURL *)containingApplicationURL {
  NSBundle *pluginBundle = [NSBundle bundleForClass:[self class]];
  NSURL *applicationURL = pluginBundle.bundleURL;
  for (NSUInteger index = 0; index < 3; index += 1) {
    applicationURL = applicationURL.URLByDeletingLastPathComponent;
  }
  if (![[applicationURL.pathExtension lowercaseString] isEqualToString:@"app"]) {
    return nil;
  }
  return applicationURL;
}

@end
